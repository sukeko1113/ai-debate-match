import { describe, expect, it } from 'vitest';

import { submitConstructive, type SubmitConstructiveParams } from '@/application/submit-constructive';
import { argumentInventoryOf } from '@/domain/arguments';
import { decideSlotAction } from '@/domain/fallback';
import { currentSlot, type MatchState } from '@/domain/match';
import type { EvidenceCardRecord, MatchRepository } from '@/domain/repositories';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  fixtureRuleSet,
  noArguments,
  startedMatch,
} from '../support/match-fixtures';

/**
 * 構造化立論の提出（設計 §8 / §13 / §14.3）。
 *
 * 状態機械・Memory Repository と繋いで、採番・本文・保存が一続きで動くことを見る。
 * AI Provider も HTTP も使わない。人間の入力はダミー値である。
 */

const MATCH_ID = 'match_test';

const CARDS: readonly Omit<EvidenceCardRecord, 'matchId'>[] = [
  {
    id: 'ev_a1',
    side: 'affirmative',
    title: '【デモ】学習時間の調査',
    sourceLabel: 'デモ資料A',
    publishedOn: '2025-04',
    quote: 'ダミー引用A',
    verificationStatus: 'unverified',
    demoOnly: true,
  },
  {
    id: 'ev_a2',
    side: 'affirmative',
    title: '【デモ】教員の業務時間',
    sourceLabel: 'デモ資料B',
    publishedOn: '2025-06',
    quote: 'ダミー引用B',
    verificationStatus: 'unverified',
    demoOnly: true,
  },
  {
    id: 'ev_n1',
    side: 'negative',
    title: '【デモ】地域クラブの受け皿',
    sourceLabel: 'デモ資料C',
    publishedOn: '2025-08',
    quote: 'ダミー引用C',
    verificationStatus: 'unverified',
    demoOnly: true,
  },
];

/** id も時刻も外から与える。domain も Repository も自分では作らない（設計 §12.1） */
function deps(repository: MatchRepository) {
  let sequence = 0;
  return {
    repository,
    newId: (prefix: string): string => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: (): string => '2026-08-24T00:00:00.000Z',
  };
}

async function setup(state: MatchState) {
  const repository = createMemoryMatchRepository();
  await repository.createMatch(state);
  for (const card of CARDS) {
    await repository.insertEvidenceCard({ ...card, matchId: state.id });
  }
  return { repository, state, deps: deps(repository) };
}

/** A1（人間）の立論を待っている状態 */
async function waitingForAffirmativeConstructive() {
  return setup(apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments }));
}

const AFFIRMATIVE_INPUT = {
  plan: '国が高校の部活動を選択制とする制度を導入する。',
  arguments: [
    {
      label: '学習時間が増える',
      body: '現在は…。選択制にすれば…。',
      evidenceCardIds: ['ev_a1'],
    },
    {
      label: '教員の負担が減る',
      body: '教員は…。',
      evidenceCardIds: ['ev_a2'],
    },
  ],
};

function params(overrides: Partial<SubmitConstructiveParams> = {}): SubmitConstructiveParams {
  return {
    matchId: MATCH_ID,
    expectedVersion: 0,
    slotIndex: 0,
    source: 'human',
    input: AFFIRMATIVE_INPUT,
    ...overrides,
  };
}

describe('立論の提出（設計 §8）', () => {
  it('採番・本文・保存が一度に確定し、状態が active へ戻る', async () => {
    const context = await waitingForAffirmativeConstructive();
    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 採番はサーバが登場順に行う（設計 §8.2）
    expect(result.argumentKeys).toEqual(['AD1', 'AD2']);
    expect(result.state.status).toBe('active');
    expect(result.state.version).toBe(context.state.version + 1);

    const stored = await context.repository.listArguments(MATCH_ID);
    expect(stored.map((row) => [row.argumentKey, row.kind, row.side, row.state])).toEqual([
      ['AD1', 'advantage', 'affirmative', 'submitted'],
      ['AD2', 'advantage', 'affirmative', 'submitted'],
    ]);
    expect(new Set(stored.map((row) => row.originSection))).toEqual(
      new Set([currentSlot(context.state)?.sectionNo]),
    );

    // speech は1件。structured_json は入力そのまま（設計 §8.2）
    const speeches = await context.repository.listSpeeches(MATCH_ID);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]?.text).toBe(result.speechText);
    expect(speeches[0]?.submitted).toBe(true);
    expect(speeches[0]?.autoFilled).toBe(false);
    expect(speeches[0]?.structuredJson).toEqual(AFFIRMATIVE_INPUT);

    // Evidence の使用は論点ごとに1行（設計 §13.1 の speech 側）
    const uses = await context.repository.listEvidenceUses(MATCH_ID);
    expect(uses.map((row) => [row.argumentKey, row.evidenceCardId, row.cxTurnId])).toEqual([
      ['AD1', 'ev_a1', null],
      ['AD2', 'ev_a2', null],
    ]);

    // 監査ログは状態機械の遷移として残る（設計 §13）
    const logs = await context.repository.listAuditLogs(MATCH_ID);
    expect(logs.at(-1)?.eventType).toBe('HUMAN_SUBMIT');
  });

  it('speechText は設計 §8.3 のテンプレートどおりである', async () => {
    const context = await waitingForAffirmativeConstructive();
    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.speechText).toBe(
      [
        '私は論題に賛成します。',
        '【プラン】国が高校の部活動を選択制とする制度を導入する。',
        '【論点1：学習時間が増える】現在は…。選択制にすれば…。',
        '（根拠：デモ資料A／2025-04「ダミー引用A」）',
        '【論点2：教員の負担が減る】教員は…。',
        '（根拠：デモ資料B／2025-06「ダミー引用B」）',
      ].join('\n'),
    );
  });

  it('同じ入力からは常に同じ key と同じ本文が出る（受入基準2）', async () => {
    const results: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const context = await waitingForAffirmativeConstructive();
      const result = await submitConstructive(
        context.deps,
        params({ expectedVersion: context.state.version }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const speeches = await context.repository.listSpeeches(MATCH_ID);
      results.push(
        JSON.stringify({
          keys: result.argumentKeys,
          text: result.speechText,
          structured: speeches[0]?.structuredJson,
        }),
      );
    }
    expect(new Set(results).size).toBe(1);
  });

  it('AIの立論も同じ経路を通る（設計 §8）', async () => {
    // 第3セクションの立論は N1（AI）
    const negativeConstructive = fixtureRuleSet.slots.find(
      (slot) => slot.kind === 'constructive' && slot.actorSeat === 'N1',
    );
    expect(negativeConstructive).toBeDefined();
    if (negativeConstructive === undefined) return;

    const atNegative = driveToSlot(negativeConstructive.index, bothSidesArguments);
    const generating = apply(atNegative, { type: 'NEED_AI', args: bothSidesArguments });
    const context = await setup(generating);

    const result = await submitConstructive(
      context.deps,
      params({
        expectedVersion: generating.version,
        slotIndex: negativeConstructive.index,
        source: 'ai',
        input: {
          arguments: [
            { label: '地域格差が広がる', body: '地域には…。', evidenceCardIds: ['ev_n1'] },
          ],
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.argumentKeys).toEqual(['DA1']);
    expect(result.speechText.startsWith('私は論題に反対します。')).toBe(true);
    expect((await context.repository.listSpeeches(MATCH_ID))[0]?.source).toBe('ai');
  });
});

describe('拒否したときは1行も書かない（設計 §14.4）', () => {
  async function expectRejected(
    overrides: Partial<SubmitConstructiveParams>,
    expectedCode: string,
  ) {
    const context = await waitingForAffirmativeConstructive();
    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version, ...overrides }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(expectedCode);

    expect(await context.repository.listArguments(MATCH_ID)).toEqual([]);
    expect(await context.repository.listSpeeches(MATCH_ID)).toEqual([]);
    expect(await context.repository.listEvidenceUses(MATCH_ID)).toEqual([]);
    // 状態も動かない
    const stored = await context.repository.findMatch(MATCH_ID);
    expect(stored?.version).toBe(context.state.version);
    expect(stored?.status).toBe('waiting_human');
    return result;
  }

  it('論点0件は INVALID_HUMAN_OUTPUT', async () => {
    await expectRejected({ input: { arguments: [] } }, 'INVALID_HUMAN_OUTPUT');
  });

  it('論点3件は INVALID_HUMAN_OUTPUT', async () => {
    const three = Array.from({ length: 3 }, (_v, i) => ({
      label: `論点${i}`,
      body: '本文',
      evidenceCardIds: [],
    }));
    await expectRejected({ input: { arguments: three } }, 'INVALID_HUMAN_OUTPUT');
  });

  it('argumentKey を送ると拒否される（採番はサーバのみ）', async () => {
    await expectRejected(
      {
        input: {
          arguments: [{ label: '論点', body: '本文', argumentKey: 'AD1', evidenceCardIds: [] }],
        },
      },
      'INVALID_HUMAN_OUTPUT',
    );
  });

  it('match 外の Evidence は棄却される', async () => {
    await expectRejected(
      {
        input: {
          arguments: [{ label: '論点', body: '本文', evidenceCardIds: ['ev_unknown'] }],
        },
      },
      'INVALID_HUMAN_OUTPUT',
    );
  });

  it('side の違う Evidence は棄却される', async () => {
    await expectRejected(
      {
        input: {
          arguments: [{ label: '論点', body: '本文', evidenceCardIds: ['ev_n1'] }],
        },
      },
      'INVALID_HUMAN_OUTPUT',
    );
  });

  it('AIの出力は AI_OUTPUT_REJECTED になる（設計 §14.4）', async () => {
    // AIの提出は generating_ai から来る。第3セクションの立論は N1（AI）である
    const negativeConstructive = fixtureRuleSet.slots.find(
      (slot) => slot.kind === 'constructive' && slot.actorSeat === 'N1',
    );
    expect(negativeConstructive).toBeDefined();
    if (negativeConstructive === undefined) return;

    const generating = apply(driveToSlot(negativeConstructive.index, bothSidesArguments), {
      type: 'NEED_AI',
      args: bothSidesArguments,
    });
    const context = await setup(generating);

    const result = await submitConstructive(
      context.deps,
      params({
        expectedVersion: generating.version,
        slotIndex: negativeConstructive.index,
        source: 'ai',
        input: { arguments: [] },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AI_OUTPUT_REJECTED');
    expect(await context.repository.listArguments(MATCH_ID)).toEqual([]);
    expect(await context.repository.listSpeeches(MATCH_ID)).toEqual([]);
  });

  it('expectedVersion 不一致は MATCH_VERSION_CONFLICT', async () => {
    await expectRejected({ expectedVersion: 99 }, 'MATCH_VERSION_CONFLICT');
  });

  it('現在スロット以外への提出は INVALID_TRANSITION', async () => {
    await expectRejected({ slotIndex: 3 }, 'INVALID_TRANSITION');
  });

  it('存在しない match は MATCH_NOT_FOUND', async () => {
    const context = await waitingForAffirmativeConstructive();
    const result = await submitConstructive(
      context.deps,
      params({ matchId: 'match_unknown', expectedVersion: context.state.version }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MATCH_NOT_FOUND');
  });

  it('Constructive 以外のスロットには提出できない（設計 §6.3）', async () => {
    const prep = fixtureRuleSet.slots.find((slot) => slot.kind === 'prep');
    expect(prep).toBeDefined();
    if (prep === undefined) return;

    const atPrep = driveToSlot(prep.index, bothSidesArguments);
    const context = await setup(atPrep);
    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: atPrep.version, slotIndex: prep.index }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(await context.repository.listArguments(MATCH_ID)).toEqual([]);
  });

  it('同じセクションの発話が既にあれば、arguments を書く前に落とす（設計 §13）', async () => {
    const context = await waitingForAffirmativeConstructive();
    const sectionNo = currentSlot(context.state)?.sectionNo;
    expect(sectionNo).toBeDefined();
    if (sectionNo === undefined || sectionNo === null) return;

    await context.repository.insertSpeech({
      id: 'speech_seed',
      matchId: MATCH_ID,
      sectionNo,
      seat: 'A1',
      source: 'human',
      text: '既にある発話',
      structuredJson: null,
      submitted: true,
      autoFilled: false,
    });

    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(await context.repository.listArguments(MATCH_ID)).toEqual([]);
    expect(await context.repository.listSpeeches(MATCH_ID)).toHaveLength(1);
  });

  it('同じ side の立論は2回書けない（設計 §6.3 / §13）', async () => {
    const context = await waitingForAffirmativeConstructive();
    await context.repository.insertArguments([
      {
        id: 'argument_seed',
        matchId: MATCH_ID,
        argumentKey: 'AD1',
        side: 'affirmative',
        kind: 'advantage',
        label: '既にある論点',
        body: '本文',
        originSection: 1,
        state: 'submitted',
      },
    ]);

    const result = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TRANSITION');
    expect(await context.repository.listArguments(MATCH_ID)).toHaveLength(1);
  });
});

describe('二重送信（設計 §11 / E03）', () => {
  it('同じ expectedVersion の2回目は通らず、speech は1件のままである', async () => {
    const context = await waitingForAffirmativeConstructive();
    const first = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );
    expect(first.ok).toBe(true);

    const second = await submitConstructive(
      context.deps,
      params({ expectedVersion: context.state.version }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('MATCH_VERSION_CONFLICT');

    expect(await context.repository.listSpeeches(MATCH_ID)).toHaveLength(1);
    expect(await context.repository.listArguments(MATCH_ID)).toHaveLength(2);
  });
});

describe('提出した論点はフォールバック判定に効く（設計 §10）', () => {
  it('立論が入ると、そのCXは固定質問へ落ちない', async () => {
    const context = await waitingForAffirmativeConstructive();
    const before = argumentInventoryOf(await context.repository.listArguments(MATCH_ID));

    const cxSlot = fixtureRuleSet.slots.find((slot) => slot.kind === 'cx');
    expect(cxSlot).toBeDefined();
    if (cxSlot === undefined) return;

    const decide = (args: typeof before) =>
      decideSlotAction(fixtureRuleSet, cxSlot, {
        args,
        seats: context.state.seats,
        cxPhase: 'question',
      });

    expect(decide(before)).toBe('cx_no_argument');

    await submitConstructive(context.deps, params({ expectedVersion: context.state.version }));
    const after = argumentInventoryOf(await context.repository.listArguments(MATCH_ID));

    expect(after.affirmative).toEqual(['AD1', 'AD2']);
    expect(decide(after)).toBe('need_ai');
  });
});
