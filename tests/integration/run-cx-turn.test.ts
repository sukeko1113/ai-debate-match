import { describe, expect, it } from 'vitest';

import { advanceMatch } from '@/application/advance-match';
import { retryCxTurn, runCxTurn, submitCxAnswer } from '@/application/run-cx-turn';
import type { AiLimits, RunAiSlotDeps } from '@/application/run-slot';
import { reduce, type MatchState } from '@/domain/match';
import type { ArgumentRecord, EvidenceCardRecord, MatchRepository } from '@/domain/repositories';
import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';
import type { MockAiResponseInput } from '@/schemas/ai-output';
import type { Persona } from '@/schemas/persona';

import { bothSidesArguments, driveToSlot, fixtureRuleSet } from '../support/match-fixtures';

/**
 * 質疑の往復（設計 §7 / §15.3）。
 *
 * 第2セクションは「AIが質問し、人間が答える」形である。
 * 往復位置はサーバだけが進め、1回の呼び出しで質問1件または回答1件しか進まない。
 */

const PERSONA: Persona = {
  difficulty: 'normal',
  maxArguments: 2,
  maxSentenceLength: 120,
  refutationDepth: 2,
  instructions: ['主張・理由・根拠の順に述べてください。'],
};

const LIMITS: AiLimits = {
  maxRunsPerMatch: 40,
  maxAttemptsPerMatch: 90,
  maxRetriesPerRun: 2,
  runTimeoutMs: 30000,
  maxMatchOutputTokens: 30000,
};

const EXCHANGES = fixtureRuleSet.constraints.cxExchangesPerSection;

function slotIndexOfSection(sectionNo: number): number {
  const slot = fixtureRuleSet.slots.find((entry) => entry.sectionNo === sectionNo);
  if (slot === undefined) throw new Error(`section ${sectionNo} が無い`);
  return slot.index;
}

const question = (turn: number) => ({
  question: `第1論点について、${turn + 1}つ目の質問です。根拠はありますか。`,
  targetArgumentKey: 'AD1',
});

const answer = (turn: number, concessionKey: string | null = null) => ({
  answer: `結論から申し上げます。${turn + 1}つ目の回答です。`,
  concessionKey,
});

async function seedMatch(sectionNo: number, responses: readonly MockAiResponseInput[]) {
  const repository: MatchRepository = createMemoryMatchRepository();
  const state = driveToSlot(slotIndexOfSection(sectionNo), bothSidesArguments);
  await repository.createMatch(state);

  const rows: ArgumentRecord[] = [
    { key: 'AD1', side: 'affirmative', kind: 'advantage', section: 1 },
    { key: 'AD2', side: 'affirmative', kind: 'advantage', section: 1 },
    { key: 'DA1', side: 'negative', kind: 'disadvantage', section: 3 },
    { key: 'DA2', side: 'negative', kind: 'disadvantage', section: 3 },
  ].map((entry) => ({
    id: `argument_${entry.key}`,
    matchId: state.id,
    argumentKey: entry.key,
    side: entry.side as ArgumentRecord['side'],
    kind: entry.kind as ArgumentRecord['kind'],
    label: `${entry.key} の論点`,
    body: '本文',
    originSection: entry.section,
    state: 'submitted' as const,
  }));
  await repository.insertArguments(rows);

  const card: EvidenceCardRecord = {
    id: 'card_aff',
    matchId: state.id,
    side: 'affirmative',
    title: '肯定側のカード',
    sourceLabel: '出典A',
    publishedOn: '2025-04',
    quote: '引用A',
    verificationStatus: 'unverified',
    demoOnly: true,
  };
  await repository.insertEvidenceCard(card);

  let sequence = 0;
  const deps: RunAiSlotDeps = {
    repository,
    provider: createMockDebateProvider({ code: 'test', responses: [...responses] }),
    personaFor: () => PERSONA,
    limits: LIMITS,
    newId: (prefix) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: () => '2026-01-01T00:00:00.000Z',
  };

  return { repository, deps, state };
}

/** 第2セクション（N4 が質問し、人間 A1 が答える）の fixture */
function section2Questions(): MockAiResponseInput[] {
  return [
    {
      role: 'cx_question',
      sectionNo: 2,
      outputs: Array.from({ length: EXCHANGES }, (_unused, turn) => question(turn)),
    },
  ];
}

describe('往復が1件ずつ進む（設計 §7 / §14.1）', () => {
  it('質問 → 回答 → 質問 と交互に進み、cursor が 0→1→2→完了 になる', async () => {
    const scene = await seedMatch(2, section2Questions());
    let state: MatchState = scene.state;
    const cursors: number[] = [];

    for (let exchange = 0; exchange < EXCHANGES; exchange += 1) {
      cursors.push(state.cx?.turnCursor ?? -1);
      expect(state.cx?.phase).toBe('question');

      // AIが質問する
      const asked = await runCxTurn(scene.deps, {
        matchId: state.id,
        expectedVersion: state.version,
      });
      expect(asked.ok).toBe(true);
      if (!asked.ok) return;
      state = asked.state;
      expect(state.cx?.phase).toBe('answer');
      expect(state.cx?.turnCursor).toBe(exchange);

      // 人間が答える（NEED_HUMAN → HUMAN_SUBMIT）
      const waiting = reduce(state, {
        type: 'NEED_HUMAN',
        expectedVersion: state.version,
        args: bothSidesArguments,
      });
      expect(waiting.ok).toBe(true);
      if (!waiting.ok) return;
      await scene.repository.updateMatch(waiting.state, state.version);

      const answered = await submitCxAnswer(scene.deps, {
        matchId: state.id,
        expectedVersion: waiting.state.version,
        slotIndex: waiting.state.currentSlotIndex,
        cxTurnIndex: exchange,
        text: `結論から申し上げます。${exchange + 1}回目の回答です。`,
        evidenceCardIds: exchange === 0 ? ['card_aff'] : [],
      });
      expect(answered.ok).toBe(true);
      if (!answered.ok) return;
      state = answered.state;
      expect(state.cx?.turnCursor).toBe(exchange + 1);
    }

    expect(cursors).toEqual([...Array(EXCHANGES).keys()]);

    // cx_turns は往復数ぶんだけ。質問と回答は同じ行である（設計 §7）
    const turns = await scene.repository.listCxTurns(state.id);
    expect(turns).toHaveLength(EXCHANGES);
    expect(turns.every((turn) => turn.answerText !== null)).toBe(true);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([...Array(EXCHANGES).keys()]);

    // Evidence の使用は cx_turn 側に書く（設計 §13.1）
    const uses = await scene.repository.listEvidenceUses(state.id);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ speechId: null, evidenceCardId: 'card_aff' });

    // 規定往復に達したのでスロットは完了し、ADVANCE が通る
    const advanced = reduce(state, {
      type: 'ADVANCE',
      expectedVersion: state.version,
      args: bothSidesArguments,
    });
    expect(advanced.ok).toBe(true);
  });

  it('未完のまま ADVANCE すると SLOT_NOT_READY（設計 §7 完了条件）', async () => {
    const scene = await seedMatch(2, section2Questions());
    const asked = await runCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const advanced = reduce(asked.state, {
      type: 'ADVANCE',
      expectedVersion: asked.state.version,
      args: bothSidesArguments,
    });
    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(advanced.error.code).toBe('SLOT_NOT_READY');
  });

  it('advance 1回で ai_runs は1件だけ増え、往復位置が入る（設計 §13.1）', async () => {
    const scene = await seedMatch(2, section2Questions());
    const advanced = await advanceMatch(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(advanced.ok).toBe(true);

    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      role: 'cx_question',
      cxTurnIndex: 0,
      attempt: 1,
      status: 'succeeded',
    });
  });
});

describe('人間の回答の検査（設計 §7 / §19）', () => {
  async function askedScene() {
    const scene = await seedMatch(2, section2Questions());
    const asked = await runCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    if (!asked.ok) throw new Error('質問の生成に失敗した');
    const waiting = reduce(asked.state, {
      type: 'NEED_HUMAN',
      expectedVersion: asked.state.version,
      args: bothSidesArguments,
    });
    if (!waiting.ok) throw new Error('NEED_HUMAN に失敗した');
    await scene.repository.updateMatch(waiting.state, asked.state.version);
    return { ...scene, state: waiting.state };
  }

  it('往復位置が現在の cursor と違えば拒否する（位置はサーバが決める）', async () => {
    const scene = await askedScene();
    const result = await submitCxAnswer(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
      slotIndex: scene.state.currentSlotIndex,
      cxTurnIndex: 2,
      text: '回答です。',
      evidenceCardIds: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SLOT_NOT_READY');
  });

  it('side が合わない Evidence は拒否する（設計 §8.2）', async () => {
    const scene = await askedScene();
    await scene.repository.insertEvidenceCard({
      id: 'card_neg',
      matchId: scene.state.id,
      side: 'negative',
      title: '否定側のカード',
      sourceLabel: '出典N',
      publishedOn: '2025-06',
      quote: '引用N',
      verificationStatus: 'unverified',
      demoOnly: true,
    });

    const result = await submitCxAnswer(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
      slotIndex: scene.state.currentSlotIndex,
      cxTurnIndex: 0,
      text: '回答です。',
      evidenceCardIds: ['card_neg'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_HUMAN_OUTPUT');
    // 拒否したときは1行も書かない
    expect(await scene.repository.listEvidenceUses(scene.state.id)).toHaveLength(0);
  });

  it('逆質問でも人間の回答は拒否しない（設計 §15.5 はAI出力の表である）', async () => {
    const scene = await askedScene();
    const result = await submitCxAnswer(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
      slotIndex: scene.state.currentSlotIndex,
      cxTurnIndex: 0,
      text: 'それはどういう意味ですか？',
      evidenceCardIds: [],
    });
    expect(result.ok).toBe(true);
  });
});

describe('AIが答える質疑（第4セクション）', () => {
  const section4 = (): MockAiResponseInput[] => [
    {
      role: 'cx_question',
      sectionNo: 4,
      outputs: Array.from({ length: EXCHANGES }, (_unused, turn) => ({
        question: `否定側の第1論点について、${turn + 1}つ目の質問です。`,
        targetArgumentKey: 'DA1',
      })),
    },
    {
      role: 'cx_answer',
      sectionNo: 4,
      outputs: [answer(0), answer(1), answer(2, 'DA1')],
    },
  ];

  it('質問と回答が同じ行に入り、譲歩が記録される（設計 §15.3）', async () => {
    const scene = await seedMatch(4, section4());
    let state = scene.state;

    for (let step = 0; step < EXCHANGES * 2; step += 1) {
      const result = await runCxTurn(scene.deps, {
        matchId: state.id,
        expectedVersion: state.version,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      state = result.state;
    }

    const turns = await scene.repository.listCxTurns(state.id);
    expect(turns).toHaveLength(EXCHANGES);
    expect(turns.every((turn) => turn.answerText !== null)).toBe(true);
    expect(turns.map((turn) => turn.concessionArgumentKey)).toEqual([null, null, 'DA1']);
    expect(turns.every((turn) => turn.targetArgumentKey === 'DA1')).toBe(true);
  });
});

describe('AI出力の棄却と再実行（設計 §15.5 / §15.6）', () => {
  it('未知keyの質問は棄却され、再生成で通る', async () => {
    const scene = await seedMatch(2, [
      {
        role: 'cx_question',
        sectionNo: 2,
        cxTurnIndex: 0,
        outputs: [{ question: '質問です。', targetArgumentKey: 'DA1' }, question(0)],
      },
    ]);

    const result = await runCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(result.ok).toBe(true);

    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'succeeded']);
    expect(await scene.repository.listCxTurns(scene.state.id)).toHaveLength(1);
  });

  it('逆質問の回答は棄却され、尽きたら paused。retry で同じ往復から再開する', async () => {
    const reverse = { answer: 'それはどういう意味ですか？', concessionKey: null };
    const scene = await seedMatch(4, [
      {
        role: 'cx_question',
        sectionNo: 4,
        outputs: [{ question: '質問です。', targetArgumentKey: 'DA1' }],
      },
      {
        role: 'cx_answer',
        sectionNo: 4,
        cxTurnIndex: 0,
        outputs: [reverse, reverse, reverse, answer(0)],
      },
    ]);

    const asked = await runCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const failed = await runCxTurn(scene.deps, {
      matchId: asked.state.id,
      expectedVersion: asked.state.version,
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.code).toBe('AI_OUTPUT_REJECTED');

    const paused = await scene.repository.findMatch(scene.state.id);
    expect(paused?.status).toBe('paused');
    // 回答はまだ書かれていない（設計 §7 の往復位置は動かない）
    const before = await scene.repository.listCxTurns(scene.state.id);
    expect(before[0]?.answerText).toBeNull();
    if (paused === null) return;

    const retried = await retryCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: paused.version,
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.state.cx?.turnCursor).toBe(1);

    const after = await scene.repository.listCxTurns(scene.state.id);
    expect(after[0]?.answerText).not.toBeNull();
  });
});

describe('打ち切り（設計 §7）', () => {
  it('HUMAN_TIMEOUT で truncated の往復が残り、スロットが完了する', async () => {
    const scene = await seedMatch(2, section2Questions());
    const asked = await runCxTurn(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const waiting = reduce(asked.state, {
      type: 'NEED_HUMAN',
      expectedVersion: asked.state.version,
      args: bothSidesArguments,
    });
    if (!waiting.ok) return;
    await scene.repository.updateMatch(waiting.state, asked.state.version);

    const timedOut = reduce(waiting.state, {
      type: 'HUMAN_TIMEOUT',
      expectedVersion: waiting.state.version,
    });
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) return;

    // 進行中の往復を truncated=true で保存する（設計 §7 打ち切り）
    await scene.repository.updateCxTurnAnswer({
      matchId: scene.state.id,
      sectionNo: 2,
      turnIndex: 0,
      answerText: '',
      truncated: true,
    });
    await scene.repository.updateMatch(timedOut.state, waiting.state.version);

    const turns = await scene.repository.listCxTurns(scene.state.id);
    expect(turns[0]?.truncated).toBe(true);

    // cursor が規定往復に達していなくても、打ち切りでスロットは完了している
    const advanced = reduce(timedOut.state, {
      type: 'ADVANCE',
      expectedVersion: timedOut.state.version,
      args: bothSidesArguments,
    });
    expect(advanced.ok).toBe(true);
  });
});
