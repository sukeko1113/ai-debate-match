import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { submitConstructive } from '@/application/submit-constructive';
import {
  argumentInventoryOf,
  constructiveLimits,
  slotSide,
  SUPPORT_USE_TYPE,
} from '@/domain/arguments';
import { currentSlot, reduce, type MatchState } from '@/domain/match';
import type { EvidenceUseRecord, MatchRepository, SpeechRecord } from '@/domain/repositories';
import {
  buildSystemPrompt,
  isAiProviderError,
  type AiRole,
  type DebateAiProvider,
} from '@/infrastructure/ai/provider';
import {
  buildAttackOutputSchema,
  buildDefenseOutputSchema,
  buildSummaryOutputSchema,
  type AttackOutput,
  type DefenseOutput,
  type SummaryOutput,
} from '@/schemas/ai-output';
import type { ApiErrorCode, Difficulty } from '@/schemas/api';
import type { Side } from '@/schemas/common';
import { buildConstructiveInputSchema, type ConstructiveInput } from '@/schemas/human-input';
import type { Persona } from '@/schemas/persona';
import type { RuleSlot } from '@/schemas/rule-set';

import { buildAiSlotInput, type AiSlotInput } from './ai-slot-input';

/**
 * AIが担当するスロットを1つ進める（設計 §14.1 / §15）。
 *
 * **1回の呼び出しで進むのは1スロット分の生成だけ**である。再試行はその中で行い、
 * 次のスロットへは進めない。ジョブキューは使わない（設計 §14.1）。
 *
 * 守りは4段あり、後ろへ行くほど保存に近い。
 *   1. system prompt が「入力にないものを作らない」と伝える（設計 §15.2）
 *   2. schema が argument key と Evidence ID を enum で閉じる（設計 §15.1）
 *   3. コードが参照集合の部分集合であることを再確認する（設計 §15.6）
 *   4. それでも違反したら再生成し、尽きたら棄却して paused（設計 §15.5）
 *
 * 3 を 2 と別に持つのは、schema を差し替えたときに守りが静かに外れないようにするためである。
 */

/** 設計 §22 の上限。値は環境変数から来る。ここに数値を書かない */
export type AiLimits = {
  readonly maxRunsPerMatch: number;
  readonly maxAttemptsPerMatch: number;
  readonly maxRetriesPerRun: number;
  readonly runTimeoutMs: number;
  readonly maxMatchOutputTokens: number;
};

export type RunAiSlotDeps = {
  readonly repository: MatchRepository;
  readonly provider: DebateAiProvider;
  /** difficulty から prompt 変数を引く（設計 §15.4） */
  readonly personaFor: (difficulty: Difficulty) => Persona;
  readonly limits: AiLimits;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

export type RunAiSlotParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type RunAiSlotResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly code: ApiErrorCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

type RoleOutput = ConstructiveInput | AttackOutput | DefenseOutput | SummaryOutput;

function fail(
  code: ApiErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): RunAiSlotResult {
  return { ok: false, code, message, details };
}

/** そのスロットでAIが担う役割。CX は P7、Judge は P9 なのでここでは扱わない */
export function aiRoleOfSlot(slot: RuleSlot): AiRole | null {
  switch (slot.kind) {
    case 'constructive':
    case 'attack':
    case 'defense':
    case 'summary':
      return slot.kind;
    default:
      return null;
  }
}

type BudgetUsage = {
  readonly runsUsed: number;
  readonly attemptsUsed: number;
  readonly outputTokensUsed: number;
};

/** 成功run と試行回数は別のカウンタで数える（設計 §17） */
async function budgetUsageOf(repository: MatchRepository, matchId: string): Promise<BudgetUsage> {
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

function budgetProblem(usage: BudgetUsage, limits: AiLimits): RunAiSlotResult | null {
  if (usage.runsUsed >= limits.maxRunsPerMatch) {
    return fail('MATCH_BUDGET_EXCEEDED', 'AI実行回数の上限に達した（設計 §17）。', {
      runsUsed: usage.runsUsed,
      limit: limits.maxRunsPerMatch,
    });
  }
  if (usage.attemptsUsed >= limits.maxAttemptsPerMatch) {
    return fail('MATCH_BUDGET_EXCEEDED', 'AI試行回数の上限に達した（設計 §17）。', {
      attemptsUsed: usage.attemptsUsed,
      limit: limits.maxAttemptsPerMatch,
    });
  }
  if (usage.outputTokensUsed >= limits.maxMatchOutputTokens) {
    return fail('MATCH_BUDGET_EXCEEDED', '出力トークンの上限に達した（設計 §17）。', {
      outputTokensUsed: usage.outputTokensUsed,
      limit: limits.maxMatchOutputTokens,
    });
  }
  return null;
}

/** 保存済みの行から次の attempt を決める。再試行をまたいで続く（設計 §13.1） */
function nextAttemptOf(
  runs: readonly { slotIndex: number; role: string; cxTurnIndex: number | null }[],
  slotIndex: number,
  role: AiRole,
): number {
  return (
    runs.filter(
      (run) => run.slotIndex === slotIndex && run.role === role && run.cxTurnIndex === null,
    ).length + 1
  );
}

/** 同じ入力からは同じ hash になる。prompt 全文は保存しない（設計 §19） */
function inputHashOf(input: AiSlotInput, promptVersion: string): string {
  return createHash('sha256')
    .update(`${promptVersion}\n${JSON.stringify(input)}`)
    .digest('hex')
    .slice(0, 32);
}

function keysOfSide(input: AiSlotInput, side: Side): string[] {
  return [...input.ownArguments, ...input.opponentArguments]
    .filter((entry) => entry.side === side)
    .map((entry) => entry.argumentKey);
}

/**
 * 役割ごとの schema。key と Evidence ID の enum を注入する（設計 §15.1 / §15.3）。
 * 返す型は役割で変わるため、呼び出し側では役割の union として扱う。
 */
function schemaFor(
  role: AiRole,
  input: AiSlotInput,
  state: MatchState,
  persona: Persona,
): z.ZodType<RoleOutput> {
  const asRoleOutput = (schema: unknown): z.ZodType<RoleOutput> =>
    schema as z.ZodType<RoleOutput>;

  switch (role) {
    case 'constructive': {
      const limits = constructiveLimits(state.ruleSet, input.side);
      // difficulty は上限を下げるだけで、rule set の上限を超えない（設計 §15.4）
      return asRoleOutput(
        buildConstructiveInputSchema({
          ...limits,
          maxArguments: Math.min(limits.maxArguments, persona.maxArguments),
        }),
      );
    }
    case 'attack':
      return asRoleOutput(
        buildAttackOutputSchema(input.opponentArguments.map((entry) => entry.argumentKey)),
      );
    case 'defense':
      return asRoleOutput(
        buildDefenseOutputSchema({
          ownKeys: input.ownArguments.map((entry) => entry.argumentKey),
          evidenceCardIds: input.evidenceCards.map((card) => card.id),
        }),
      );
    case 'summary':
      return asRoleOutput(
        buildSummaryOutputSchema({
          affirmativeKeys: keysOfSide(input, 'affirmative'),
          negativeKeys: keysOfSide(input, 'negative'),
        }),
      );
    default:
      throw new Error(`P6 が扱う役割ではない: ${role}（CXは P7、Judge は P9）`);
  }
}

/**
 * 参照が許可集合の部分集合であることを、schema とは別に確かめる（設計 §15.6）。
 * schema を通ったあとの最後の確認であり、ここで落ちたものは保存しない。
 */
export function referenceViolations(
  role: AiRole,
  output: RoleOutput,
  input: AiSlotInput,
): string[] {
  const allowedOwn = input.ownArguments.map((entry) => entry.argumentKey);
  const allowedOpponent = input.opponentArguments.map((entry) => entry.argumentKey);
  const allowedCards = input.evidenceCards.map((card) => card.id);
  const problems: string[] = [];

  const checkKey = (key: string, allowed: readonly string[], where: string): void => {
    if (!allowed.includes(key)) {
      problems.push(`${where}: 入力に無い argument_key である: ${key}（設計 §15.6）`);
    }
  };
  const checkCard = (id: string, where: string): void => {
    if (!allowedCards.includes(id)) {
      problems.push(`${where}: 入力に無い evidence_card_id である: ${id}（設計 §15.6）`);
    }
  };

  switch (role) {
    case 'constructive': {
      (output as ConstructiveInput).arguments.forEach((argument, position) => {
        argument.evidenceCardIds.forEach((id) => checkCard(id, `arguments.${position}`));
      });
      return problems;
    }
    case 'attack': {
      (output as AttackOutput).refutations.forEach((refutation, position) =>
        checkKey(refutation.argumentKey, allowedOpponent, `refutations.${position}`),
      );
      return problems;
    }
    case 'defense': {
      const defense = output as DefenseOutput;
      defense.defenses.forEach((entry, position) =>
        checkKey(entry.argumentKey, allowedOwn, `defenses.${position}`),
      );

      // 同じ論点で同じカードを2回使うと evidence_uses の部分一意索引に当たる（設計 §13.1）。
      // 保存の途中で落ちると speech だけが残るため、保存前に落とす。
      const seenUses = new Set<string>();
      defense.evidenceUses.forEach((entry, position) => {
        checkKey(entry.argumentKey, allowedOwn, `evidenceUses.${position}`);
        checkCard(entry.evidenceCardId, `evidenceUses.${position}`);

        const useKey = `${entry.argumentKey}\u0000${entry.evidenceCardId}`;
        if (seenUses.has(useKey)) {
          problems.push(
            `evidenceUses.${position}: 同じ論点で同じ Evidence を2回使えない（設計 §13.1）`,
          );
        }
        seenUses.add(useKey);
      });
      return problems;
    }
    case 'summary': {
      const affirmative = keysOfSide(input, 'affirmative');
      const negative = keysOfSide(input, 'negative');
      (output as SummaryOutput).comparisons.forEach((comparison, position) => {
        checkKey(comparison.affKey, affirmative, `comparisons.${position}.affKey`);
        checkKey(comparison.negKey, negative, `comparisons.${position}.negKey`);
      });
      return problems;
    }
    default:
      return problems;
  }
}

/** speeches と evidence_uses を書き、AI_SUCCEEDED まで進める（Constructive 以外） */
async function commitSpeechOutput(
  deps: RunAiSlotDeps,
  state: MatchState,
  slot: RuleSlot,
  output: AttackOutput | DefenseOutput | SummaryOutput,
): Promise<RunAiSlotResult> {
  if (slot.sectionNo === null || slot.actorSeat === null) {
    return fail('INVALID_TRANSITION', '競技スロットに sectionNo と actorSeat が必要である。', {
      slotIndex: slot.index,
    });
  }

  // 状態機械を先に引く。通らなければ1行も書かない（P4 と同じ順序）
  const transition = reduce(state, { type: 'AI_SUCCEEDED', expectedVersion: state.version });
  if (!transition.ok) {
    return fail(transition.error.code, transition.error.message, transition.error.details);
  }

  const speechId = deps.newId('speech');
  const speech: SpeechRecord = {
    id: speechId,
    matchId: state.id,
    sectionNo: slot.sectionNo,
    seat: slot.actorSeat,
    source: 'ai',
    text: output.speechText,
    /** 反論・再構築・比較の構造はここに残る。Defense と Judge の入力になる（設計 §15.3） */
    structuredJson: output,
    submitted: true,
    autoFilled: false,
  };
  await deps.repository.insertSpeech(speech);

  // arguments に行は増えない。増えるのは Constructive だけである（設計 §6.3）
  if ('evidenceUses' in output) {
    for (const use of output.evidenceUses) {
      const record: EvidenceUseRecord = {
        id: deps.newId('evidence_use'),
        matchId: state.id,
        speechId,
        cxTurnId: null,
        evidenceCardId: use.evidenceCardId,
        argumentKey: use.argumentKey,
        useType: SUPPORT_USE_TYPE,
      };
      await deps.repository.insertEvidenceUse(record);
    }
  }

  await deps.repository.updateMatch(transition.state, state.version);
  await deps.repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}

/** 生成 → 検証 → 保存。status=generating_ai の状態から呼ぶ */
async function generateAndCommit(
  deps: RunAiSlotDeps,
  generating: MatchState,
  slot: RuleSlot,
  role: AiRole,
): Promise<RunAiSlotResult> {
  const { repository } = deps;
  const matchId = generating.id;
  const persona = deps.personaFor(generating.difficulty);

  const [argumentRows, cards, speeches] = await Promise.all([
    repository.listArguments(matchId),
    repository.listEvidenceCards(matchId),
    repository.listSpeeches(matchId),
  ]);

  const input = buildAiSlotInput({
    state: generating,
    slot,
    role,
    argumentRows,
    cards,
    speeches,
    argumentLimits:
      role === 'constructive'
        ? {
            min: constructiveLimits(generating.ruleSet, slotSide(slot)).minArguments,
            max: Math.min(
              constructiveLimits(generating.ruleSet, slotSide(slot)).maxArguments,
              persona.maxArguments,
            ),
          }
        : null,
  });
  const schema = schemaFor(role, input, generating, persona);
  const inputHash = inputHashOf(input, deps.provider.promptVersion);

  const maxAttempts = 1 + deps.limits.maxRetriesPerRun;
  let repairIssues: readonly string[] = [];
  let lastFailure: { code: ApiErrorCode; message: string; issues: readonly string[] } | null = null;

  for (let round = 0; round < maxAttempts; round += 1) {
    const runs = await repository.listAiRuns(matchId);
    const usage = await budgetUsageOf(repository, matchId);
    const overBudget = budgetProblem(usage, deps.limits);
    if (overBudget !== null) return overBudget;

    const attempt = nextAttemptOf(runs, slot.index, role);
    const remainingTokens = deps.limits.maxMatchOutputTokens - usage.outputTokensUsed;

    try {
      const result = await deps.provider.generate({
        role,
        schema,
        systemPrompt: buildSystemPrompt({ role, persona, repairIssues }),
        input,
        maxOutputTokens: remainingTokens,
        timeoutMs: deps.limits.runTimeoutMs,
        idempotencyKey: `${matchId}:${slot.index}:-1:${role}:${attempt}`,
      });

      const violations = referenceViolations(role, result.parsed, input);
      if (violations.length > 0) {
        await repository.insertAiRun({
          id: deps.newId('ai_run'),
          matchId,
          slotIndex: slot.index,
          cxTurnIndex: null,
          role,
          provider: deps.provider.name,
          model: deps.provider.model,
          promptVersion: deps.provider.promptVersion,
          inputHash,
          attempt,
          status: 'rejected',
          outputJson: result.parsed,
          usageJson: result.usage,
          errorCode: 'AI_OUTPUT_REJECTED',
        });
        repairIssues = violations;
        lastFailure = {
          code: 'AI_OUTPUT_REJECTED',
          message: 'AIの出力が競技制約に違反した（設計 §15.6）。',
          issues: violations,
        };
        continue;
      }

      await repository.insertAiRun({
        id: deps.newId('ai_run'),
        matchId,
        slotIndex: slot.index,
        cxTurnIndex: null,
        role,
        provider: deps.provider.name,
        model: deps.provider.model,
        promptVersion: deps.provider.promptVersion,
        inputHash,
        attempt,
        status: 'succeeded',
        outputJson: result.parsed,
        usageJson: result.usage,
        errorCode: null,
      });

      if (role === 'constructive') {
        const submitted = await submitConstructive(deps, {
          matchId,
          expectedVersion: generating.version,
          slotIndex: slot.index,
          source: 'ai',
          input: result.parsed,
        });
        return submitted.ok
          ? { ok: true, state: submitted.state }
          : fail(submitted.code, submitted.message, submitted.details);
      }

      return commitSpeechOutput(
        deps,
        generating,
        slot,
        result.parsed as AttackOutput | DefenseOutput | SummaryOutput,
      );
    } catch (error) {
      if (!isAiProviderError(error)) throw error;

      await repository.insertAiRun({
        id: deps.newId('ai_run'),
        matchId,
        slotIndex: slot.index,
        cxTurnIndex: null,
        role,
        provider: deps.provider.name,
        model: deps.provider.model,
        promptVersion: deps.provider.promptVersion,
        inputHash,
        attempt,
        status: 'failed',
        outputJson: error.raw,
        usageJson: null,
        errorCode: error.kind === 'schema' ? 'AI_OUTPUT_REJECTED' : 'AI_PROVIDER_UNAVAILABLE',
      });

      repairIssues = error.issues;
      lastFailure = {
        code: error.kind === 'schema' ? 'AI_OUTPUT_REJECTED' : 'AI_PROVIDER_UNAVAILABLE',
        message: error.message,
        issues: error.issues,
      };

      // timeout の自動再試行は1回まで。provider 障害は繰り返さない（設計 §15.5）
      if (error.kind === 'unavailable') break;
      if (error.kind === 'timeout' && round >= 1) break;
    }
  }

  // 出力が確定しなかった。paused にして Retry を待つ（設計 §11 AI_FAILED）
  const failure = lastFailure ?? {
    code: 'AI_OUTPUT_REJECTED' as ApiErrorCode,
    message: 'AIの出力が確定しなかった。',
    issues: [] as readonly string[],
  };
  const paused = reduce(generating, {
    type: 'AI_FAILED',
    expectedVersion: generating.version,
    errorCode: failure.code,
  });
  if (!paused.ok) {
    return fail(paused.error.code, paused.error.message, paused.error.details);
  }
  await repository.updateMatch(paused.state, generating.version);
  await repository.appendAuditLogs(paused.auditEvents, deps.now());

  return fail(failure.code, failure.message, {
    slotIndex: slot.index,
    role,
    issues: failure.issues,
  });
}

/** advance から呼ぶ。active → NEED_AI → 生成（設計 §11 / §14.1） */
export async function runAiSlot(
  deps: RunAiSlotDeps,
  params: RunAiSlotParams,
): Promise<RunAiSlotResult> {
  const { repository } = deps;
  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return fail('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const slot = currentSlot(state);
  if (slot === null) {
    return fail('INVALID_TRANSITION', '現在スロットが進行配列の範囲外である。', {
      slotIndex: state.currentSlotIndex,
    });
  }

  const role = aiRoleOfSlot(slot);
  if (role === null) {
    return fail(
      'AI_PROVIDER_UNAVAILABLE',
      'この役割の生成は後続のPRで追加される（CXは P7、判定は P9）。',
      { slotIndex: slot.index, slotKind: slot.kind },
    );
  }

  const overBudget = budgetProblem(await budgetUsageOf(repository, params.matchId), deps.limits);
  if (overBudget !== null) return overBudget;

  const args = argumentInventoryOf(await repository.listArguments(params.matchId));
  const transition = reduce(state, {
    type: 'NEED_AI',
    expectedVersion: params.expectedVersion,
    args,
  });
  if (!transition.ok) {
    return fail(transition.error.code, transition.error.message, transition.error.details);
  }
  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());

  return generateAndCommit(deps, transition.state, slot, role);
}

/** retry-ai から呼ぶ。paused → RETRY_AI → 同じ slot で再実行（設計 §11 RETRY_AI） */
export async function retryAiSlot(
  deps: RunAiSlotDeps,
  params: RunAiSlotParams,
): Promise<RunAiSlotResult> {
  const { repository } = deps;
  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return fail('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const slot = currentSlot(state);
  const role = slot === null ? null : aiRoleOfSlot(slot);
  if (slot === null || role === null) {
    return fail('INVALID_TRANSITION', '再実行できるスロットではない。', {
      slotIndex: state.currentSlotIndex,
      slotKind: slot?.kind ?? null,
    });
  }

  const overBudget = budgetProblem(await budgetUsageOf(repository, params.matchId), deps.limits);
  if (overBudget !== null) return overBudget;

  const transition = reduce(state, { type: 'RETRY_AI', expectedVersion: params.expectedVersion });
  if (!transition.ok) {
    return fail(transition.error.code, transition.error.message, transition.error.details);
  }
  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());

  return generateAndCommit(deps, transition.state, slot, role);
}
