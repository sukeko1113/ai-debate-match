import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import {
  buildSystemPrompt,
  isAiProviderError,
  type AiRole,
  type DebateAiProvider,
} from '@/infrastructure/ai/provider';
import type { ApiErrorCode, Difficulty } from '@/schemas/api';
import type { Persona } from '@/schemas/persona';

/**
 * AI生成の共通部分（設計 §15.5 / §17）。
 *
 * スピーチ（P6）も質疑（P7）も、再試行の仕方・`ai_runs` の残し方・上限の数え方は同じである。
 * 違うのは「何を渡して、通ったら何を保存するか」だけなので、そこだけを呼び出し側に残す。
 *
 * ここは状態を進めない。遷移は呼び出し側が行う。
 */

/** 設計 §22 の上限。値は環境変数から来る。ここに数値を書かない */
export type AiLimits = {
  readonly maxRunsPerMatch: number;
  readonly maxAttemptsPerMatch: number;
  readonly maxRetriesPerRun: number;
  readonly runTimeoutMs: number;
  readonly maxMatchOutputTokens: number;
};

export type AiGenerationDeps = {
  readonly repository: MatchRepository;
  readonly provider: DebateAiProvider;
  /** difficulty から prompt 変数を引く（設計 §15.4） */
  readonly personaFor: (difficulty: Difficulty) => Persona;
  readonly limits: AiLimits;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

/** 状態を確定させるだけの処理に要る依存。AI を呼ばない経路からも使う */
export type TransitionDeps = Pick<AiGenerationDeps, 'repository' | 'now'>;

export type GenerationFailure = {
  readonly ok: false;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

export function failure(
  code: ApiErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): GenerationFailure {
  return { ok: false, code, message, details };
}

type BudgetUsage = {
  readonly runsUsed: number;
  readonly attemptsUsed: number;
  readonly outputTokensUsed: number;
};

/** 成功run と試行回数は別のカウンタで数える（設計 §17） */
export async function budgetUsageOf(
  repository: MatchRepository,
  matchId: string,
): Promise<BudgetUsage> {
  const runs = await repository.listAiRuns(matchId);
  const outputTokensUsed = runs.reduce((total, run) => {
    const usage = run.usageJson;
    if (usage === null || typeof usage !== 'object') return total;
    const outputTokens = (usage as { outputTokens?: unknown }).outputTokens;
    return typeof outputTokens === 'number' ? total + outputTokens : total;
  }, 0);

  return {
    runsUsed: runs.filter((run) => run.status === 'succeeded').length,
    attemptsUsed: runs.length,
    outputTokensUsed,
  };
}

export function budgetProblem(usage: BudgetUsage, limits: AiLimits): GenerationFailure | null {
  if (usage.runsUsed >= limits.maxRunsPerMatch) {
    return failure('MATCH_BUDGET_EXCEEDED', 'AI実行回数の上限に達した（設計 §17）。', {
      runsUsed: usage.runsUsed,
      limit: limits.maxRunsPerMatch,
    });
  }
  if (usage.attemptsUsed >= limits.maxAttemptsPerMatch) {
    return failure('MATCH_BUDGET_EXCEEDED', 'AI試行回数の上限に達した（設計 §17）。', {
      attemptsUsed: usage.attemptsUsed,
      limit: limits.maxAttemptsPerMatch,
    });
  }
  if (usage.outputTokensUsed >= limits.maxMatchOutputTokens) {
    return failure('MATCH_BUDGET_EXCEEDED', '出力トークンの上限に達した（設計 §17）。', {
      outputTokensUsed: usage.outputTokensUsed,
      limit: limits.maxMatchOutputTokens,
    });
  }
  return null;
}

/** 上限に達していないかを、状態を動かす前に確かめる */
export async function budgetProblemOf(
  deps: AiGenerationDeps,
  matchId: string,
): Promise<GenerationFailure | null> {
  return budgetProblem(await budgetUsageOf(deps.repository, matchId), deps.limits);
}

/** 同じ入力からは同じ hash になる。prompt 全文は保存しない（設計 §19） */
function inputHashOf(input: unknown, promptVersion: string): string {
  return createHash('sha256')
    .update(`${promptVersion}\n${JSON.stringify(input)}`)
    .digest('hex')
    .slice(0, 32);
}

/** その位置で何回試したか。再試行は保存済みの行から続く（設計 §13.1） */
async function nextAttempt(
  repository: MatchRepository,
  matchId: string,
  slotIndex: number,
  cxTurnIndex: number | null,
  role: AiRole,
): Promise<number> {
  const runs = await repository.listAiRuns(matchId);
  return (
    runs.filter(
      (run) =>
        run.slotIndex === slotIndex && run.role === role && run.cxTurnIndex === cxTurnIndex,
    ).length + 1
  );
}

export type GenerationRequest<TOutput> = {
  readonly role: AiRole;
  readonly schema: z.ZodType<TOutput>;
  /** `sectionNo` を必ず含める。Mock はこれで fixture を引く（設計 §15.7） */
  readonly input: Readonly<Record<string, unknown>>;
  readonly persona: Persona;
  readonly slotIndex: number;
  /** CX以外は null（設計 §13.1 の COALESCE 対象） */
  readonly cxTurnIndex: number | null;
  /** schema を通ったあとの追加検証。違反があれば再生成する（設計 §15.6） */
  readonly validate: (output: TOutput) => string[];
};

export type GenerationOutcome<TOutput> =
  | { readonly ok: true; readonly output: TOutput }
  | GenerationFailure;

/**
 * 生成 → 検証 → 記録を、上限に達するまで繰り返す（設計 §15.5）。
 *
 * 成功しても状態は進めない。保存と遷移は呼び出し側が行う。
 * ここで返る失敗は「この位置の出力が確定しなかった」という意味であり、
 * 呼び出し側が `AI_FAILED` を送って `paused` にする。
 */
export async function generateWithRetries<TOutput>(
  deps: AiGenerationDeps,
  matchId: string,
  request: GenerationRequest<TOutput>,
): Promise<GenerationOutcome<TOutput>> {
  const { repository, provider } = deps;
  const inputHash = inputHashOf(request.input, provider.promptVersion);
  const maxAttempts = 1 + deps.limits.maxRetriesPerRun;

  let repairIssues: readonly string[] = [];
  let last: GenerationFailure | null = null;

  for (let round = 0; round < maxAttempts; round += 1) {
    const overBudget = await budgetProblemOf(deps, matchId);
    if (overBudget !== null) return overBudget;

    const usage = await budgetUsageOf(repository, matchId);
    const attempt = await nextAttempt(
      repository,
      matchId,
      request.slotIndex,
      request.cxTurnIndex,
      request.role,
    );

    const runRow = {
      id: deps.newId('ai_run'),
      matchId,
      slotIndex: request.slotIndex,
      cxTurnIndex: request.cxTurnIndex,
      role: request.role,
      provider: provider.name,
      model: provider.model,
      promptVersion: provider.promptVersion,
      inputHash,
      attempt,
    };

    try {
      const result = await provider.generate({
        role: request.role,
        schema: request.schema,
        systemPrompt: buildSystemPrompt({
          role: request.role,
          persona: request.persona,
          repairIssues,
        }),
        input: request.input,
        maxOutputTokens: deps.limits.maxMatchOutputTokens - usage.outputTokensUsed,
        timeoutMs: deps.limits.runTimeoutMs,
        idempotencyKey: `${matchId}:${request.slotIndex}:${request.cxTurnIndex ?? -1}:${request.role}:${attempt}`,
      });

      const violations = request.validate(result.parsed);
      if (violations.length > 0) {
        await repository.insertAiRun({
          ...runRow,
          status: 'rejected',
          outputJson: result.parsed,
          usageJson: result.usage,
          errorCode: 'AI_OUTPUT_REJECTED',
        });
        repairIssues = violations;
        last = failure('AI_OUTPUT_REJECTED', 'AIの出力が競技制約に違反した（設計 §15.6）。', {
          issues: violations,
        });
        continue;
      }

      await repository.insertAiRun({
        ...runRow,
        status: 'succeeded',
        outputJson: result.parsed,
        usageJson: result.usage,
        errorCode: null,
      });
      return { ok: true, output: result.parsed };
    } catch (error) {
      if (!isAiProviderError(error)) throw error;

      const code: ApiErrorCode =
        error.kind === 'schema' ? 'AI_OUTPUT_REJECTED' : 'AI_PROVIDER_UNAVAILABLE';
      await repository.insertAiRun({
        ...runRow,
        status: 'failed',
        outputJson: error.raw,
        usageJson: null,
        errorCode: code,
      });

      repairIssues = error.issues;
      last = failure(code, error.message, { issues: error.issues });

      // timeout の自動再試行は1回まで。provider 障害は繰り返さない（設計 §15.5）
      if (error.kind === 'unavailable') break;
      if (error.kind === 'timeout' && round >= 1) break;
    }
  }

  return last ?? failure('AI_OUTPUT_REJECTED', 'AIの出力が確定しなかった（設計 §15.5）。');
}

/**
 * 出力が確定しなかったので `paused` にする（設計 §11 AI_FAILED）。
 * 位置は動かさない。`retry-ai` が同じ位置から再開する。
 */
export async function pauseAfterFailure(
  deps: TransitionDeps,
  generating: MatchState,
  reason: GenerationFailure,
): Promise<GenerationFailure> {
  const paused = reduce(generating, {
    type: 'AI_FAILED',
    expectedVersion: generating.version,
    errorCode: reason.code,
  });
  if (!paused.ok) {
    return failure(paused.error.code, paused.error.message, paused.error.details);
  }

  await deps.repository.updateMatch(paused.state, generating.version);
  await deps.repository.appendAuditLogs(paused.auditEvents, deps.now());
  return reason;
}

/** 遷移を1つ確定させ、保存と監査ログまで行う */
export async function commitTransition(
  deps: TransitionDeps,
  state: MatchState,
  event: Parameters<typeof reduce>[1],
): Promise<{ ok: true; state: MatchState } | GenerationFailure> {
  const transition = reduce(state, event);
  if (!transition.ok) {
    return failure(transition.error.code, transition.error.message, transition.error.details);
  }
  await deps.repository.updateMatch(transition.state, state.version);
  await deps.repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}
