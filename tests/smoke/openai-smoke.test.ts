import { describe, expect, it } from 'vitest';

import { advanceMatch, skipPrep, type AdvanceMatchDeps } from '@/application/advance-match';
import { createMatch } from '@/application/create-match';
import { judgeMatch } from '@/application/judge-match';
import { submitCxAnswer } from '@/application/run-cx-turn';
import type { AiLimits } from '@/application/run-slot';
import { submitConstructive } from '@/application/submit-constructive';
import { argumentInventoryOf } from '@/domain/arguments';
import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { createOpenAiDebateProvider } from '@/infrastructure/ai/openai-provider';
import { getServerEnv } from '@/infrastructure/config/env';
import { loadMotion, loadPersona, loadRuleSet } from '@/infrastructure/content';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

/**
 * 実 Provider の手動スモーク（設計 §20 P10「manual smoke」）。
 *
 * **CI では実行しない。** `pnpm test` の対象外（`vitest.config.mts` の include を参照）で、
 * `pnpm smoke:openai` からだけ動く。鍵が無ければ何もせずに落ちる。
 *
 * 見るのは「7役割が実モデルで1回ずつ通り、usage が §17 の上限の内側に収まるか」である。
 * 出力の良し悪しは人が読む。ここでは競技制約（未知key・逆質問・根拠section）を
 * 通常の検証経路がそのまま守ることだけを確かめる。
 *
 * **1回あたり実費がかかる。** 何度も回さないこと。
 */

const RULE_SET = loadRuleSet();
const MOTION = loadMotion();

/** 設計 §17 の上限。実測がこの内側に収まるかを見る */
const LIMITS: AiLimits = {
  maxRunsPerMatch: 40,
  maxAttemptsPerMatch: 90,
  maxRetriesPerRun: 2,
  runTimeoutMs: 30000,
  maxMatchOutputTokens: 30000,
};

const EXPECTED_ROLES = [
  'constructive',
  'cx_question',
  'cx_answer',
  'attack',
  'defense',
  'summary',
  'judge',
] as const;

type Scene = {
  readonly repository: MatchRepository;
  readonly deps: AdvanceMatchDeps;
  readonly matchId: string;
};

async function startedMatch(): Promise<Scene> {
  const env = getServerEnv();
  const repository = createMemoryMatchRepository();

  let sequence = 0;
  const deps: AdvanceMatchDeps = {
    repository,
    // 鍵は env からだけ読む。ここに書かない（設計 §19）
    provider: createOpenAiDebateProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_TEXT_MODEL,
    }),
    personaFor: loadPersona,
    noArgumentCxQuestionsFor: () => MOTION.noArgumentCxQuestions,
    limits: { ...LIMITS, runTimeoutMs: env.AI_RUN_TIMEOUT_MS },
    newId: (prefix) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: () => new Date().toISOString(),
  };

  const created = await createMatch(deps, {
    ruleSet: RULE_SET,
    motion: MOTION,
    playerName: 'スモーク太郎',
    difficulty: 'normal',
  });
  const args = argumentInventoryOf(await repository.listArguments(created.state.id));
  const started = reduce(created.state, {
    type: 'START',
    expectedVersion: created.state.version,
    args,
  });
  if (!started.ok) throw new Error('START に失敗した');
  await repository.updateMatch(started.state, created.state.version);

  return { repository, deps, matchId: created.state.id };
}

async function currentState(scene: Scene): Promise<MatchState> {
  const state = await scene.repository.findMatch(scene.matchId);
  if (state === null) throw new Error('match が消えた');
  return state;
}

/** 人間（A1）の入力。実モデルの出来を見るのが目的なので、内容は固定でよい */
async function humanPlays(scene: Scene, state: MatchState): Promise<void> {
  const cards = await scene.repository.listEvidenceCards(scene.matchId);
  const card = cards.find((entry) => entry.side === 'affirmative');

  if (state.cx === null) {
    const submitted = await submitConstructive(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
      slotIndex: state.currentSlotIndex,
      source: 'human',
      input: {
        plan: '国が高校の部活動を地域クラブへ段階的に移行する。',
        arguments: [
          {
            label: '学習時間が増える',
            body: '部活動が長時間に及ぶ現状を改めれば、生徒が学習に使える時間が増えます。',
            evidenceCardIds: card === undefined ? [] : [card.id],
          },
        ],
      },
    });
    if (!submitted.ok) throw new Error(`立論が通らない: ${submitted.code} ${submitted.message}`);
    return;
  }

  const answered = await submitCxAnswer(scene.deps, {
    matchId: scene.matchId,
    expectedVersion: state.version,
    slotIndex: state.currentSlotIndex,
    cxTurnIndex: state.cx.turnCursor,
    text: '結論から申し上げます。制度の設計で対応できます。',
    evidenceCardIds: [],
  });
  if (!answered.ok) throw new Error(`回答が通らない: ${answered.code} ${answered.message}`);
}

const env = (() => {
  try {
    return getServerEnv();
  } catch {
    return null;
  }
})();

const ready =
  env !== null &&
  env.AI_PROVIDER === 'openai' &&
  env.OPENAI_TEXT_MODEL !== '' &&
  env.OPENAI_API_KEY !== '';

describe.skipIf(!ready)('実 Provider の手動スモーク（設計 §20 P10）', () => {
  it(
    '7役割が実モデルで通り、17スロットを完走して判定まで到達する',
    { timeout: 20 * 60 * 1000 },
    async () => {
      const scene = await startedMatch();

      for (let step = 0; step < 200; step += 1) {
        const state = await currentState(scene);
        if (state.status === 'completed') break;

        if (state.status === 'waiting_human') {
          await humanPlays(scene, state);
          continue;
        }
        if (state.status === 'prep_running') {
          const skipped = await skipPrep(scene.deps, {
            matchId: scene.matchId,
            expectedVersion: state.version,
          });
          expect(skipped.ok).toBe(true);
          continue;
        }

        const advanced = await advanceMatch(scene.deps, {
          matchId: scene.matchId,
          expectedVersion: state.version,
        });
        if (!advanced.ok) {
          throw new Error(
            `advance が止まった（slot=${state.currentSlotIndex}）: ${advanced.code} ${advanced.message}`,
          );
        }
      }

      const beforeJudge = await currentState(scene);
      expect(beforeJudge.status).toBe('completed');

      const judged = await judgeMatch(scene.deps, {
        matchId: scene.matchId,
        expectedVersion: beforeJudge.version,
      });
      expect(judged.ok).toBe(true);
      if (!judged.ok) return;

      const runs = await scene.repository.listAiRuns(scene.matchId);
      const succeeded = runs.filter((run) => run.status === 'succeeded');
      const outputTokens = runs.reduce((sum, run) => {
        const usage = run.usageJson as { outputTokens?: number } | null;
        return sum + (usage?.outputTokens ?? 0);
      }, 0);

      // 役割ごとの実行回数と usage を人が読めるように出す（報告に貼る）
      const perRole = EXPECTED_ROLES.map((role) => ({
        role,
        succeeded: succeeded.filter((run) => run.role === role).length,
        attempts: runs.filter((run) => run.role === role).length,
      }));
      console.info(
        JSON.stringify(
          {
            model: scene.deps.provider.model,
            perRole,
            succeededRuns: succeeded.length,
            attempts: runs.length,
            outputTokens,
            limits: {
              maxRunsPerMatch: LIMITS.maxRunsPerMatch,
              maxAttemptsPerMatch: LIMITS.maxAttemptsPerMatch,
              maxMatchOutputTokens: LIMITS.maxMatchOutputTokens,
            },
            score: judged.result.match.score,
            learnerScore: judged.result.learnerReport.score,
            needsReviewReasons: judged.result.match.needsReviewReasons,
          },
          null,
          2,
        ),
      );

      // 7役割それぞれが1回は通っている
      for (const role of EXPECTED_ROLES) {
        expect(succeeded.filter((run) => run.role === role).length).toBeGreaterThan(0);
      }
      // 設計 §17 の上限の内側に収まっている
      expect(succeeded.length).toBeLessThanOrEqual(LIMITS.maxRunsPerMatch);
      expect(runs.length).toBeLessThanOrEqual(LIMITS.maxAttemptsPerMatch);
      expect(outputTokens).toBeLessThanOrEqual(LIMITS.maxMatchOutputTokens);

      // 判定には根拠のセクションが必ず付く（設計 §16.3）
      expect(judged.result.match.axes.every((axis) => axis.sectionIds.length > 0)).toBe(true);
    },
  );
});

describe.skipIf(ready)('鍵が無いときは何も呼ばない', () => {
  it('スモークの前提が揃っていないことを知らせる', () => {
    // AI_PROVIDER=openai・OPENAI_TEXT_MODEL・OPENAI_API_KEY の3つが要る（設計 §22）
    expect(ready).toBe(false);
  });
});
