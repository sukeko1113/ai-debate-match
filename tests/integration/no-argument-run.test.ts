import { describe, expect, it } from 'vitest';

import { advanceMatch, skipPrep, type AdvanceMatchDeps } from '@/application/advance-match';
import { createMatch } from '@/application/create-match';
import { submitCxAnswer } from '@/application/run-cx-turn';
import type { AiLimits } from '@/application/run-slot';
import { argumentInventoryOf } from '@/domain/arguments';
import { NO_TARGET_ATTACK_TEXT, NO_TARGET_DEFENSE_TEXT } from '@/domain/fallback';
import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { loadMockAiFixture, loadMotion, loadPersona, loadRuleSet } from '@/infrastructure/content';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

/**
 * A1が立論を出さないまま完走する（設計 §10 / §20 P8 / E11）。
 *
 * 肯定側の論点が0件になると、CXの `targetArgumentKey` も Attack の反論対象も
 * Defense の再構築対象も消える。設計 §10 はこの衝突を経路ごとに解いており、
 * ここではその表どおりに**第12セクションまで到達すること**を見る。
 *
 * 使うのは本番の rule set と論題である。固定質問は論題から読む（設計 §10.1）。
 * AI は Mock で、論点0件の筋書き用の fixture を読む（設計 §15.7）。
 */

const RULE_SET = loadRuleSet();
const MOTION = loadMotion();
const EXCHANGES = RULE_SET.constraints.cxExchangesPerSection;

const LIMITS: AiLimits = {
  maxRunsPerMatch: 40,
  maxAttemptsPerMatch: 90,
  maxRetriesPerRun: 2,
  runTimeoutMs: 30000,
  maxMatchOutputTokens: 30000,
};

function slotIndexOfSection(sectionNo: number): number {
  const slot = RULE_SET.slots.find((entry) => entry.sectionNo === sectionNo);
  if (slot === undefined) throw new Error(`section ${sectionNo} が無い`);
  return slot.index;
}

type Scene = {
  readonly repository: MatchRepository;
  readonly deps: AdvanceMatchDeps;
  readonly matchId: string;
};

async function startedMatch(): Promise<Scene> {
  const repository = createMemoryMatchRepository();
  let sequence = 0;
  const deps: AdvanceMatchDeps = {
    repository,
    provider: createMockDebateProvider(loadMockAiFixture('no-argument')),
    personaFor: loadPersona,
    // 固定質問は論題から読む。AIには作らせない（設計 §10.1）
    noArgumentCxQuestionsFor: (code) => {
      expect(code).toBe(MOTION.code);
      return MOTION.noArgumentCxQuestions;
    },
    limits: LIMITS,
    newId: (prefix) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: () => '2026-08-24T00:00:00.000Z',
  };

  const created = await createMatch(deps, {
    ruleSet: RULE_SET,
    motion: MOTION,
    playerName: 'テスト太郎',
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

/** 人間が何も出さない（設計 §11 HUMAN_TIMEOUT）。realtime の時計は P8 の範囲外である */
async function humanTimeout(scene: Scene): Promise<void> {
  const state = await currentState(scene);
  const timedOut = reduce(state, { type: 'HUMAN_TIMEOUT', expectedVersion: state.version });
  if (!timedOut.ok) throw new Error(`HUMAN_TIMEOUT が通らない: ${timedOut.error.message}`);
  await scene.repository.updateMatch(timedOut.state, state.version);
  await scene.repository.appendAuditLogs(timedOut.auditEvents, scene.deps.now());
}

type HumanTurn = (scene: Scene, state: MatchState) => Promise<void>;

/**
 * 完走するまで1歩ずつ進める。進むのは常に1ステップだけである（設計 §14.1）。
 * 人間の手番の扱いだけを呼び出し側から差し替える。
 */
async function runToCompletion(scene: Scene, onHumanTurn: HumanTurn): Promise<MatchState> {
  for (let step = 0; step < 200; step += 1) {
    const state = await currentState(scene);
    if (state.status === 'completed') return state;

    if (state.status === 'waiting_human') {
      await onHumanTurn(scene, state);
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
        `advance が止まった（slot=${state.currentSlotIndex}, status=${state.status}）: ${advanced.code} ${advanced.message}`,
      );
    }
  }
  throw new Error('200ステップで完走しなかった');
}

describe('A1が立論を出さないまま完走する（設計 §10 / §20 P8）', () => {
  it('第12セクションまで到達し、途中で止まらない', async () => {
    const scene = await startedMatch();
    const final = await runToCompletion(scene, humanTimeout);

    expect(final.status).toBe('completed');
    // 17スロットすべてが確定している（done または skipped_no_target）
    expect(final.slotStatuses.filter((status) => status === 'pending')).toHaveLength(0);
    expect(final.slotStatuses).toHaveLength(RULE_SET.slots.length);

    // 第12セクションの発話が保存されている
    const speeches = await scene.repository.listSpeeches(scene.matchId);
    expect(speeches.find((speech) => speech.sectionNo === 12)).toBeDefined();

    // 論点は否定側だけである。肯定側は1件も増えない（設計 §6.3）
    const args = await scene.repository.listArguments(scene.matchId);
    expect(args.filter((row) => row.side === 'affirmative')).toHaveLength(0);
    expect(args.map((row) => row.argumentKey).sort()).toEqual(['DA1', 'DA2']);
  });

  it('AI実行回数が設計 §17 の論点0件の行と一致する', async () => {
    const scene = await startedMatch();
    await runToCompletion(scene, humanTimeout);

    const runs = await scene.repository.listAiRuns(scene.matchId);
    const succeeded = runs.filter((run) => run.status === 'succeeded');
    // 設計 §17: 判定を除いて 23 回（判定1回を足して 24）
    expect(succeeded).toHaveLength(23);
    expect(runs).toHaveLength(succeeded.length);

    // 固定文と固定質問の経路は ai_runs に行を作らない
    const bySlot = new Set(succeeded.map((run) => run.slotIndex));
    expect(bySlot.has(slotIndexOfSection(2))).toBe(false);
    expect(bySlot.has(slotIndexOfSection(5))).toBe(false);
    expect(bySlot.has(slotIndexOfSection(9))).toBe(false);
  });

  it('第5セクションと第9セクションが固定文で埋まる（設計 §10 / §10.2）', async () => {
    const scene = await startedMatch();
    const final = await runToCompletion(scene, humanTimeout);

    const speeches = await scene.repository.listSpeeches(scene.matchId);
    const attack = speeches.find((speech) => speech.sectionNo === 5);
    const defense = speeches.find((speech) => speech.sectionNo === 9);

    expect(attack?.text).toBe(NO_TARGET_ATTACK_TEXT);
    expect(attack?.source).toBe('auto_fill');
    expect(attack?.autoFilled).toBe(true);
    expect(defense?.text).toBe(NO_TARGET_DEFENSE_TEXT);
    expect(defense?.autoFilled).toBe(true);

    expect(final.slotStatuses[slotIndexOfSection(5)]).toBe('skipped_no_target');
    expect(final.slotStatuses[slotIndexOfSection(9)]).toBe('skipped_no_target');

    // 固定文は Evidence を使わない（設計 §15.6）
    const uses = await scene.repository.listEvidenceUses(scene.matchId);
    const autoFilledIds = [attack?.id, defense?.id].filter(
      (id): id is string => id !== undefined,
    );
    expect(uses.filter((use) => use.speechId !== null && autoFilledIds.includes(use.speechId)))
      .toHaveLength(0);
  });

  it('自動充填が監査ログに残る（設計 §10.2）', async () => {
    const scene = await startedMatch();
    await runToCompletion(scene, humanTimeout);

    const logs = await scene.repository.listAuditLogs(scene.matchId);
    const autoFills = logs.filter((log) => log.eventType === 'AUTO_FILL');
    // 第5・第9セクションの固定文と、第2セクションの固定質問（往復1件目）
    expect(autoFills.length).toBeGreaterThanOrEqual(3);
    expect(autoFills.every((log) => log.actor === 'server')).toBe(true);
  });

  it('論点0件でも Summary はAIが書き、比較は空配列になる（設計 §10 / §17）', async () => {
    const scene = await startedMatch();
    await runToCompletion(scene, humanTimeout);

    const speeches = await scene.repository.listSpeeches(scene.matchId);
    for (const sectionNo of [11, 12]) {
      const summary = speeches.find((speech) => speech.sectionNo === sectionNo);
      expect(summary?.source).toBe('ai');
      expect(summary?.autoFilled).toBe(false);
      expect((summary?.structuredJson as { comparisons: unknown[] }).comparisons).toEqual([]);
    }
  });
});

describe('論点0件の第2セクションCX（設計 §10 / §10.1）', () => {
  /** 第2セクションだけ人間が答え、それ以降は何も出さない */
  function answerSection2Only(): HumanTurn {
    return async (scene, state) => {
      if (state.currentSlotIndex !== slotIndexOfSection(2) || state.cx === null) {
        await humanTimeout(scene);
        return;
      }
      const submitted = await submitCxAnswer(scene.deps, {
        matchId: scene.matchId,
        expectedVersion: state.version,
        slotIndex: state.currentSlotIndex,
        cxTurnIndex: state.cx.turnCursor,
        text: `${state.cx.turnCursor + 1}件目の質問に答えます。`,
        evidenceCardIds: [],
      });
      if (!submitted.ok) {
        throw new Error(`回答が通らない: ${submitted.code} ${submitted.message}`);
      }
    };
  }

  it('cx_mode が no_argument になり、論題の固定質問が順に出る', async () => {
    const scene = await startedMatch();
    // 第1セクションは未提出のまま終わる。第2セクションだけ人間が答える
    await runToCompletion(scene, answerSection2Only());

    const turns = (await scene.repository.listCxTurns(scene.matchId))
      .filter((turn) => turn.sectionNo === 2)
      .sort((left, right) => left.turnIndex - right.turnIndex);

    expect(turns).toHaveLength(EXCHANGES);
    expect(turns.map((turn) => turn.questionText)).toEqual(
      MOTION.noArgumentCxQuestions.slice(0, EXCHANGES),
    );
    // 参照できる論点が無いので対象は null である（設計 §10）
    expect(turns.every((turn) => turn.targetArgumentKey === null)).toBe(true);
    expect(turns.every((turn) => turn.answerText !== null)).toBe(true);
  });

  it('固定質問の経路は ai_runs を1件も増やさない（設計 §10.1 / §17）', async () => {
    const scene = await startedMatch();
    await runToCompletion(scene, answerSection2Only());

    const runs = await scene.repository.listAiRuns(scene.matchId);
    expect(runs.filter((run) => run.slotIndex === slotIndexOfSection(2))).toHaveLength(0);
  });

  it('第8セクションのCXは、対象keyが無くてもAIが質問する（設計 §10 / §17）', async () => {
    const scene = await startedMatch();
    await runToCompletion(scene, humanTimeout);

    const turns = (await scene.repository.listCxTurns(scene.matchId)).filter(
      (turn) => turn.sectionNo === 8,
    );
    expect(turns).toHaveLength(EXCHANGES);
    // 肯定側の論点が0件なので対象は null。質問の対象は直前のスピーチそのものである
    expect(turns.every((turn) => turn.targetArgumentKey === null)).toBe(true);

    const runs = await scene.repository.listAiRuns(scene.matchId);
    expect(runs.filter((run) => run.slotIndex === slotIndexOfSection(8))).toHaveLength(
      EXCHANGES * 2,
    );
  });
});
