import { describe, expect, it } from 'vitest';

import { advanceMatch } from '@/application/advance-match';
import {
  buildAiSlotInput,
  referenceViolations,
  retryAiSlot,
  runAiSlot,
  type AiLimits,
  type RunAiSlotDeps,
} from '@/application/run-slot';
import type { MatchState } from '@/domain/match';
import type { ArgumentRecord, EvidenceCardRecord, MatchRepository } from '@/domain/repositories';
import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';
import type { MockAiResponse } from '@/schemas/ai-output';
import type { Persona } from '@/schemas/persona';

import { bothSidesArguments, driveToSlot, fixtureRuleSet } from '../support/match-fixtures';

/**
 * AIスロットの実行（設計 §15 / §17）。
 *
 * ここで確かめるのは「入力に無いものが保存されないこと」と、
 * 「1回の呼び出しで生成が1回だけ進むこと」である。
 * 画面からは第2セクションのCXで止まるため（P7）、Attack 以降は状態機械を直接進めて確かめる。
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

function slotIndexOfSection(sectionNo: number): number {
  const slot = fixtureRuleSet.slots.find((entry) => entry.sectionNo === sectionNo);
  if (slot === undefined) throw new Error(`section ${sectionNo} が無い`);
  return slot.index;
}

const VALID_ATTACK = {
  speechText: '肯定側の第1論点に反論します。増えた時間が学習に使われる根拠がありません。',
  refutations: [{ argumentKey: 'AD1', point: '時間が学習へ振り替わる根拠が示されていません。' }],
};

const UNKNOWN_KEY_ATTACK = {
  speechText: '反論します。',
  refutations: [{ argumentKey: 'AD9', point: '存在しない論点への反論です。' }],
};

async function seedArguments(
  repository: MatchRepository,
  matchId: string,
): Promise<readonly ArgumentRecord[]> {
  const rows: ArgumentRecord[] = [
    { key: 'AD1', side: 'affirmative', kind: 'advantage', section: 1, label: '学習時間が増える' },
    { key: 'AD2', side: 'affirmative', kind: 'advantage', section: 1, label: '教員の負担が減る' },
    { key: 'DA1', side: 'negative', kind: 'disadvantage', section: 3, label: '受け皿が足りない' },
    { key: 'DA2', side: 'negative', kind: 'disadvantage', section: 3, label: '家計の負担が増える' },
  ].map((entry) => ({
    id: `argument_${entry.key}`,
    matchId,
    argumentKey: entry.key,
    side: entry.side as ArgumentRecord['side'],
    kind: entry.kind as ArgumentRecord['kind'],
    label: entry.label,
    body: '本文',
    originSection: entry.section,
    state: 'submitted' as const,
  }));
  await repository.insertArguments(rows);
  return rows;
}

async function seedCards(
  repository: MatchRepository,
  matchId: string,
): Promise<readonly EvidenceCardRecord[]> {
  const cards: EvidenceCardRecord[] = [
    {
      id: 'card_aff',
      matchId,
      side: 'affirmative',
      title: '肯定側のカード',
      sourceLabel: '出典A',
      publishedOn: '2025-04',
      quote: '引用A',
      verificationStatus: 'unverified',
      demoOnly: true,
    },
    {
      id: 'card_neg',
      matchId,
      side: 'negative',
      title: '否定側のカード',
      sourceLabel: '出典N',
      publishedOn: '2025-06',
      quote: '引用N',
      verificationStatus: 'unverified',
      demoOnly: true,
    },
  ];
  for (const card of cards) await repository.insertEvidenceCard(card);
  return cards;
}

type Scene = {
  readonly deps: RunAiSlotDeps;
  readonly repository: MatchRepository;
  readonly state: MatchState;
};

/** 指定セクションのスロット先頭（status=active）まで進め、論点と Evidence を保存しておく */
async function sceneAt(
  sectionNo: number,
  responses: readonly MockAiResponse[],
  limits: AiLimits = LIMITS,
): Promise<Scene> {
  const repository = createMemoryMatchRepository();
  const state = driveToSlot(slotIndexOfSection(sectionNo), bothSidesArguments);
  await repository.createMatch(state);
  await seedArguments(repository, state.id);
  await seedCards(repository, state.id);

  let sequence = 0;
  const deps: RunAiSlotDeps = {
    repository,
    provider: createMockDebateProvider({ code: 'test', responses: [...responses] }),
    personaFor: () => PERSONA,
    limits,
    newId: (prefix) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: () => '2026-01-01T00:00:00.000Z',
  };

  return { deps, repository, state };
}

describe('Attack の生成（設計 §15.3 / §14.1）', () => {
  it('生成して保存し、arguments は増えない（設計 §6.3）', async () => {
    const scene = await sceneAt(5, [{ role: 'attack', sectionNo: 5, outputs: [VALID_ATTACK] }]);
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.status).toBe('active');

    const speeches = await scene.repository.listSpeeches(scene.state.id);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]).toMatchObject({ sectionNo: 5, seat: 'N2', source: 'ai', submitted: true });
    expect(speeches[0]?.text).toBe(VALID_ATTACK.speechText);
    // 反論の構造は structured_json に残り、Defense の入力になる（設計 §15.3）
    expect(speeches[0]?.structuredJson).toMatchObject({ refutations: VALID_ATTACK.refutations });

    expect(await scene.repository.listArguments(scene.state.id)).toHaveLength(4);
  });

  it('1回の呼び出しで ai_runs は1件だけ増える（E12 / 設計 §14.1）', async () => {
    const scene = await sceneAt(5, [{ role: 'attack', sectionNo: 5, outputs: [VALID_ATTACK] }]);
    await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      slotIndex: slotIndexOfSection(5),
      cxTurnIndex: null,
      role: 'attack',
      attempt: 1,
      status: 'succeeded',
      provider: 'mock',
    });
    expect(runs[0]?.inputHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('advance からも同じ経路を通る', async () => {
    const scene = await sceneAt(5, [{ role: 'attack', sectionNo: 5, outputs: [VALID_ATTACK] }]);
    const result = await advanceMatch(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(true);
    expect(await scene.repository.listAiRuns(scene.state.id)).toHaveLength(1);
  });
});

describe('未知の argument_key は棄却される（受入基準2 / E06）', () => {
  it('3回失敗したら paused になり、speech も arguments も増えない', async () => {
    const scene = await sceneAt(5, [
      { role: 'attack', sectionNo: 5, outputs: [UNKNOWN_KEY_ATTACK] },
    ]);
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AI_OUTPUT_REJECTED');

    const stored = await scene.repository.findMatch(scene.state.id);
    expect(stored?.status).toBe('paused');
    expect(await scene.repository.listSpeeches(scene.state.id)).toHaveLength(0);
    expect(await scene.repository.listArguments(scene.state.id)).toHaveLength(4);

    // 試行はすべて記録される（設計 §17 の試行カウンタ）
    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs).toHaveLength(1 + LIMITS.maxRetriesPerRun);
    expect(runs.every((run) => run.status === 'failed')).toBe(true);
    expect(runs.map((run) => run.attempt)).toEqual([1, 2, 3]);
  });

  it('1回違反しても再生成で成功すれば speech は1件だけである（受入基準4）', async () => {
    const scene = await sceneAt(5, [
      { role: 'attack', sectionNo: 5, outputs: [UNKNOWN_KEY_ATTACK, VALID_ATTACK] },
    ]);
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(true);
    expect(await scene.repository.listSpeeches(scene.state.id)).toHaveLength(1);

    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'succeeded']);
  });
});

describe('paused からの再実行（設計 §11 RETRY_AI / 受入基準5）', () => {
  it('同じスロットのまま attempt を続けて再開する', async () => {
    const scene = await sceneAt(5, [
      {
        role: 'attack',
        sectionNo: 5,
        outputs: [UNKNOWN_KEY_ATTACK, UNKNOWN_KEY_ATTACK, UNKNOWN_KEY_ATTACK, VALID_ATTACK],
      },
    ]);
    const first = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });
    expect(first.ok).toBe(false);

    const paused = await scene.repository.findMatch(scene.state.id);
    expect(paused?.status).toBe('paused');
    if (paused === null) return;

    const retried = await retryAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: paused.version,
    });

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.state.currentSlotIndex).toBe(slotIndexOfSection(5));

    const runs = await scene.repository.listAiRuns(scene.state.id);
    expect(runs.map((run) => run.attempt)).toEqual([1, 2, 3, 4]);
    expect(await scene.repository.listSpeeches(scene.state.id)).toHaveLength(1);
  });
});

describe('Defense と Summary（設計 §15.3）', () => {
  it('Defense は自陣keyを再構築し、使った Evidence を evidence_uses に残す', async () => {
    const output = {
      speechText: '第1論点を再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '制度の趣旨から説明します。' }],
      evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_aff' }],
    };
    const scene = await sceneAt(9, [{ role: 'defense', sectionNo: 9, outputs: [output] }]);
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(true);
    const uses = await scene.repository.listEvidenceUses(scene.state.id);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      evidenceCardId: 'card_aff',
      argumentKey: 'AD1',
      cxTurnId: null,
    });
  });

  it('同じ Evidence を2回使う出力は、保存前に落ちて試合が詰まらない（設計 §13.1）', async () => {
    const duplicated = {
      speechText: '第1論点を再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '制度の趣旨から説明します。' }],
      evidenceUses: [
        { argumentKey: 'AD1', evidenceCardId: 'card_aff' },
        { argumentKey: 'AD1', evidenceCardId: 'card_aff' },
      ],
    };
    const good = {
      speechText: '第1論点を再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '制度の趣旨から説明します。' }],
      evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_aff' }],
    };

    const scene = await sceneAt(9, [
      { role: 'defense', sectionNo: 9, outputs: [duplicated, duplicated, duplicated, good] },
    ]);
    const first = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(first.ok).toBe(false);
    // 保存に手を付けないまま paused になる。speech が残ると retry で
    // UNIQUE(match_id, section_no) に当たり、そのスロットから永久に進めなくなる
    expect(await scene.repository.listSpeeches(scene.state.id)).toHaveLength(0);
    expect(await scene.repository.listEvidenceUses(scene.state.id)).toHaveLength(0);

    const paused = await scene.repository.findMatch(scene.state.id);
    expect(paused?.status).toBe('paused');
    if (paused === null) return;

    const retried = await retryAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: paused.version,
    });
    expect(retried.ok).toBe(true);
    expect(await scene.repository.listSpeeches(scene.state.id)).toHaveLength(1);
    expect(await scene.repository.listEvidenceUses(scene.state.id)).toHaveLength(1);
  });

  it('Summary は双方の既存keyを比較する', async () => {
    const output = {
      speechText: '争点を整理します。',
      comparisons: [{ affKey: 'AD1', negKey: 'DA1', winner: 'affirmative' }],
    };
    const scene = await sceneAt(11, [{ role: 'summary', sectionNo: 11, outputs: [output] }]);
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(true);
    const speeches = await scene.repository.listSpeeches(scene.state.id);
    expect(speeches[0]?.structuredJson).toMatchObject({ comparisons: output.comparisons });
  });
});

describe('AIの立論も採番はサーバが行う（設計 §8.2）', () => {
  it('第3セクションの立論から DA1・DA2 が採番される', async () => {
    const output = {
      plan: null,
      arguments: [
        { label: '受け皿が足りない', body: '地域クラブは不足しています。', evidenceCardIds: [] },
        { label: '家計の負担が増える', body: '会費が必要になります。', evidenceCardIds: [] },
      ],
    };
    const repository = createMemoryMatchRepository();
    const state = driveToSlot(slotIndexOfSection(3), {
      affirmative: ['AD1', 'AD2'],
      negative: [],
    });
    await repository.createMatch(state);
    await repository.insertArguments([
      {
        id: 'argument_AD1',
        matchId: state.id,
        argumentKey: 'AD1',
        side: 'affirmative',
        kind: 'advantage',
        label: '学習時間が増える',
        body: '本文',
        originSection: 1,
        state: 'submitted',
      },
    ]);

    let sequence = 0;
    const deps: RunAiSlotDeps = {
      repository,
      provider: createMockDebateProvider({
        code: 'test',
        responses: [{ role: 'constructive', sectionNo: 3, outputs: [output] }],
      }),
      personaFor: () => PERSONA,
      limits: LIMITS,
      newId: (prefix) => {
        sequence += 1;
        return `${prefix}_${sequence}`;
      },
      now: () => '2026-01-01T00:00:00.000Z',
    };

    const result = await runAiSlot(deps, { matchId: state.id, expectedVersion: state.version });
    expect(result.ok).toBe(true);

    const rows = await repository.listArguments(state.id);
    expect(rows.filter((row) => row.side === 'negative').map((row) => row.argumentKey)).toEqual([
      'DA1',
      'DA2',
    ]);

    // speechText はサーバが組み立てる（設計 §8.3）
    const speeches = await repository.listSpeeches(state.id);
    expect(speeches[0]?.text.startsWith('私は論題に反対します。')).toBe(true);
  });
});

describe('上限（設計 §17 / 受入基準11）', () => {
  it('成功runの上限を超えたら状態を変えずに 429 相当を返す', async () => {
    const scene = await sceneAt(5, [{ role: 'attack', sectionNo: 5, outputs: [VALID_ATTACK] }], {
      ...LIMITS,
      maxRunsPerMatch: 0,
    });
    const result = await runAiSlot(scene.deps, {
      matchId: scene.state.id,
      expectedVersion: scene.state.version,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MATCH_BUDGET_EXCEEDED');

    const stored = await scene.repository.findMatch(scene.state.id);
    expect(stored?.status).toBe('active');
    expect(stored?.version).toBe(scene.state.version);
    expect(await scene.repository.listAiRuns(scene.state.id)).toHaveLength(0);
  });
});

describe('決定性（設計 §15.7 / 受入基準7）', () => {
  it('同じ入力から10回とも同じ本文になる', async () => {
    const texts: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const scene = await sceneAt(5, [{ role: 'attack', sectionNo: 5, outputs: [VALID_ATTACK] }]);
      await runAiSlot(scene.deps, {
        matchId: scene.state.id,
        expectedVersion: scene.state.version,
      });
      const speeches = await scene.repository.listSpeeches(scene.state.id);
      texts.push(speeches[0]?.text ?? '');
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe(VALID_ATTACK.speechText);
  });
});

describe('参照の再確認は schema と別に持つ（設計 §15.6）', () => {
  const input = buildAiSlotInput({
    state: driveToSlot(slotIndexOfSection(5), bothSidesArguments),
    slot: fixtureRuleSet.slots[slotIndexOfSection(5)]!,
    role: 'attack',
    argumentRows: [
      {
        id: 'argument_AD1',
        matchId: 'match_test',
        argumentKey: 'AD1',
        side: 'affirmative',
        kind: 'advantage',
        label: '学習時間が増える',
        body: '本文',
        originSection: 1,
        state: 'submitted',
      },
    ],
    cards: [],
    speeches: [],
    argumentLimits: null,
  });

  it('入力に無いkeyを見つける', () => {
    expect(referenceViolations('attack', UNKNOWN_KEY_ATTACK, input)).toHaveLength(1);
    expect(referenceViolations('attack', VALID_ATTACK, input)).toEqual([]);
  });

  it('入力に無い Evidence ID を見つける', () => {
    const output = {
      plan: null,
      arguments: [{ label: 'x', body: 'y', evidenceCardIds: ['ev_unknown'] }],
    };
    expect(referenceViolations('constructive', output, input)).toHaveLength(1);
  });
});
