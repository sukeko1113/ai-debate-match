import { beforeAll, describe, expect, it } from 'vitest';

import { advanceMatch, skipPrep, type AdvanceMatchDeps } from '@/application/advance-match';
import { createMatch } from '@/application/create-match';
import { RUBRIC_VERSION, judgeMatch } from '@/application/judge-match';
import { submitCxAnswer } from '@/application/run-cx-turn';
import type { AiLimits } from '@/application/run-slot';
import { submitConstructive } from '@/application/submit-constructive';
import { argumentInventoryOf } from '@/domain/arguments';
import { reduce, type MatchState } from '@/domain/match';
import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { loadMockAiFixture, loadMotion, loadPersona, loadRuleSet } from '@/infrastructure/content';
import {
  createPostgresMatchRepository,
  type PostgresMatchRepository,
} from '@/infrastructure/repositories/postgres';

import { describeRepositoryContract } from '../support/repository-contract';
import { POSTGRES_URL, ensureSchema, hasPostgres } from '../support/postgres';

/**
 * Postgres Repository（ADR 0001 / 設計 §13 / §13.1 / §21.2 / §22）。
 *
 * **`DATABASE_URL` が無ければ丸ごと skip する。** CI はDBを持たず、既定は Memory である。
 * 走らせるときは先に `supabase/migrations/` を当てる（無ければこの test が当てる）。
 *
 * 見るのは3つである。
 * 1. Memory と**同じ契約テスト**を通ること
 * 2. 17スロットを完走し、判定まで到達すること
 * 3. **接続を作り直しても試合が残ること**（プロセス再起動と同じこと）
 */

const MATCH_ID = 'match_repo_postgres';

/** 契約テストは実装ごとに1つの接続を使い回す。試合は afterEach で消える */
let contractRepository: PostgresMatchRepository | null = null;

describeRepositoryContract({
  name: 'Postgres',
  matchId: MATCH_ID,
  skip: !hasPostgres,
  createRepository: async () => {
    await ensureSchema();
    contractRepository ??= createPostgresMatchRepository(POSTGRES_URL);
    // 前の実行が落ちて残っていても、同じところから始められるようにする
    await contractRepository.deleteMatch(MATCH_ID);
    return contractRepository;
  },
  // SQL からは rule set を参照できない。設計 §13 のとおり数値の CHECK だけを持つ
  rejectsUnknownSectionNo: false,
  teardown: async () => {
    await contractRepository?.close();
    contractRepository = null;
  },
});

const RULE_SET = loadRuleSet();
const MOTION = loadMotion();

const LIMITS: AiLimits = {
  maxRunsPerMatch: 40,
  maxAttemptsPerMatch: 90,
  maxRetriesPerRun: 2,
  runTimeoutMs: 30000,
  maxMatchOutputTokens: 30000,
};

type Scene = {
  readonly repository: PostgresMatchRepository;
  readonly deps: AdvanceMatchDeps;
  readonly matchId: string;
};

/**
 * 行の id はテーブル全体で一意である（設計 §13）。
 * 同じDBを使う他のテストとぶつからないよう、この筋書きだけの接頭辞を付ける。
 */
function newIdFactory(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => {
    sequence += 1;
    return `${prefix}_pgrun_${sequence}`;
  };
}

async function startedMatch(repository: PostgresMatchRepository): Promise<Scene> {
  const fixture = loadMockAiFixture('default');
  const deps: AdvanceMatchDeps = {
    repository,
    provider: createMockDebateProvider(fixture),
    personaFor: loadPersona,
    noArgumentCxQuestionsFor: () => MOTION.noArgumentCxQuestions,
    limits: LIMITS,
    newId: newIdFactory(),
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

/** 人間（A1）は立論1件と質疑の回答を出す */
async function humanPlays(scene: Scene, state: MatchState): Promise<void> {
  if (state.cx === null) {
    const cards = await scene.repository.listEvidenceCards(scene.matchId);
    const card = cards.find((entry) => entry.side === 'affirmative');
    const submitted = await submitConstructive(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
      slotIndex: state.currentSlotIndex,
      source: 'human',
      input: {
        plan: '国が高校の部活動を選択制とする。',
        arguments: [
          {
            label: '学習時間が増える',
            body: '部活動が長時間に及ぶ現状を選択制に変えれば、生徒の学習時間が増えます。',
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
    text: `結論から申し上げます。${state.cx.turnCursor + 1}件目の回答です。`,
    evidenceCardIds: [],
  });
  if (!answered.ok) throw new Error(`回答が通らない: ${answered.code} ${answered.message}`);
}

async function runToCompletion(scene: Scene): Promise<MatchState> {
  for (let step = 0; step < 200; step += 1) {
    const state = await currentState(scene);
    if (state.status === 'completed') return state;

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
  throw new Error('200ステップで完走しなかった');
}

/**
 * この筋書きの試合 id は `newId` が決める（`match_pgrun_1`）。
 * 前の実行が途中で落ちても同じところから始められるよう、先に消しておく。
 */
const RUN_MATCH_ID = 'match_pgrun_1';

describe.skipIf(!hasPostgres)('Postgres で17スロットを完走する（設計 §6.1 / §16 / §21.2）', () => {
  let repository: PostgresMatchRepository;
  let scene: Scene;
  let final: MatchState;
  let judgedStatus: string;

  // 完走と判定は1度だけ行う。個々の it は保存された結果を見る
  beforeAll(async () => {
    await ensureSchema();
    repository = createPostgresMatchRepository(POSTGRES_URL);
    await repository.deleteMatch(RUN_MATCH_ID);

    scene = await startedMatch(repository);
    final = await runToCompletion(scene);

    const judged = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: final.version,
    });
    if (!judged.ok) throw new Error(`判定が通らない: ${judged.code} ${judged.message}`);
    judgedStatus = judged.state.status;
  }, 120_000);

  it('17スロットすべてが確定し、判定まで到達する', async () => {
    expect(scene.matchId).toBe(RUN_MATCH_ID);
    expect(final.status).toBe('completed');
    expect(final.slotStatuses).toHaveLength(RULE_SET.slots.length);
    expect(final.slotStatuses.filter((status) => status === 'pending')).toHaveLength(0);
    expect(judgedStatus).toBe('judged');

    const run = await repository.findJudgingRun(scene.matchId, RUBRIC_VERSION);
    expect(run?.status).toBe('succeeded');
  });

  it('発話・質疑・論点・Evidence の使用が保存されている（設計 §13）', async () => {
    const [speeches, cxTurns, args, uses, aiRuns, logs] = await Promise.all([
      repository.listSpeeches(scene.matchId),
      repository.listCxTurns(scene.matchId),
      repository.listArguments(scene.matchId),
      repository.listEvidenceUses(scene.matchId),
      repository.listAiRuns(scene.matchId),
      repository.listAuditLogs(scene.matchId),
    ]);

    // 競技12セクションのうち、CXの4つを除く8つに発話がある（設計 §6.1）
    expect(speeches).toHaveLength(8);
    expect(cxTurns.length).toBe(4 * RULE_SET.constraints.cxExchangesPerSection);
    expect(cxTurns.every((turn) => turn.answerText !== null)).toBe(true);
    expect(args.map((row) => row.argumentKey).sort()).toEqual(['AD1', 'DA1', 'DA2']);
    expect(uses.length).toBeGreaterThan(0);
    expect(aiRuns.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('接続を作り直しても試合が残る（設計 §22 / ADR 0001）', async () => {
    // プロセス再起動と同じこと。別の Pool で読み直す
    const reopened = createPostgresMatchRepository(POSTGRES_URL);
    try {
      const found = await reopened.findMatch(scene.matchId);
      expect(found).not.toBeNull();
      expect(found?.status).toBe('judged');
      expect(found?.slotStatuses).toEqual(final.slotStatuses);
      expect(found?.seats).toHaveLength(8);
      expect(await reopened.listSpeeches(scene.matchId)).toHaveLength(8);
    } finally {
      await reopened.close();
    }
  });

  it('demo reset が match 配下を1トランザクションで消す（設計 §19）', async () => {
    expect(await repository.deleteMatch(scene.matchId)).toBe(true);

    expect(await repository.findMatch(scene.matchId)).toBeNull();
    expect(await repository.listSpeeches(scene.matchId)).toHaveLength(0);
    expect(await repository.listCxTurns(scene.matchId)).toHaveLength(0);
    expect(await repository.listArguments(scene.matchId)).toHaveLength(0);
    expect(await repository.listEvidenceUses(scene.matchId)).toHaveLength(0);
    expect(await repository.listEvidenceCards(scene.matchId)).toHaveLength(0);
    expect(await repository.listAiRuns(scene.matchId)).toHaveLength(0);
    expect(await repository.listJudgingRuns(scene.matchId)).toHaveLength(0);
    expect(await repository.listAuditLogs(scene.matchId)).toHaveLength(0);

    await repository.close();
  });
});
