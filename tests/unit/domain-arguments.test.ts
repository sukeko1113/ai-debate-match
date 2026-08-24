import { describe, expect, it } from 'vitest';

import {
  argumentInventoryOf,
  argumentKeyAt,
  argumentKindForSide,
  assignArgumentKeys,
  buildArgumentDrafts,
  buildConstructiveSpeechText,
  constructiveLimits,
  slotSide,
  validateEvidenceSelection,
  type EvidenceCardView,
} from '@/domain/arguments';
import { decideSlotAction } from '@/domain/fallback';
import type { Side } from '@/schemas/common';
import { parseConstructiveInput, type ConstructiveInput } from '@/schemas/human-input';
import type { RuleSlot } from '@/schemas/rule-set';

import { defaultSeats, fixtureRuleSet } from '../support/match-fixtures';

/**
 * AD/DA 採番と speechText の組み立て（設計 §8.2 / §8.3）。
 * 採番はサーバだけが行い、同じ入力からは常に同じ key と同じ本文が出る。
 */

/** セクション番号ではなく kind と席で引く（CLAUDE.md: 競技順序をコードに書かない） */
function slotOf(kind: RuleSlot['kind'], actorSeat?: string): RuleSlot {
  const slot = fixtureRuleSet.slots.find(
    (entry) => entry.kind === kind && (actorSeat === undefined || entry.actorSeat === actorSeat),
  );
  if (slot === undefined) throw new Error(`該当スロットが無い（kind=${kind}）`);
  return slot;
}

const affirmativeConstructive = slotOf('constructive', 'A1');
const negativeConstructive = slotOf('constructive', 'N1');

const cards: EvidenceCardView[] = [
  {
    id: 'ev_001',
    side: 'affirmative',
    sourceLabel: 'デモ資料A',
    publishedOn: '2025-04',
    quote: 'ダミー引用A',
  },
  {
    id: 'ev_002',
    side: 'affirmative',
    sourceLabel: 'デモ資料B',
    publishedOn: '2025-06',
    quote: 'ダミー引用B',
  },
  {
    id: 'ev_003',
    side: 'negative',
    sourceLabel: 'デモ資料C',
    publishedOn: '2025-08',
    quote: 'ダミー引用C',
  },
];

function inputOf(side: Side, raw: unknown): ConstructiveInput {
  const result = parseConstructiveInput(constructiveLimits(fixtureRuleSet, side), raw);
  if (!result.ok) throw new Error(`fixture が検証を通らない: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const twoArguments = {
  plan: '国が高校の部活動を選択制とする制度を導入する。',
  arguments: [
    { label: '学習時間が増える', body: '現在は…。選択制にすれば…。', evidenceCardIds: ['ev_001'] },
    { label: '教員の負担が減る', body: '教員は…。', evidenceCardIds: [] },
  ],
};

describe('kind と key は side から決まる（設計 §8.2）', () => {
  it('肯定側は advantage / AD、否定側は disadvantage / DA', () => {
    expect(argumentKindForSide('affirmative')).toBe('advantage');
    expect(argumentKindForSide('negative')).toBe('disadvantage');
    expect(argumentKeyAt('affirmative', 0)).toBe('AD1');
    expect(argumentKeyAt('negative', 1)).toBe('DA2');
  });

  it('登場順に採番する', () => {
    expect(assignArgumentKeys('affirmative', 2)).toEqual(['AD1', 'AD2']);
    expect(assignArgumentKeys('negative', 2)).toEqual(['DA1', 'DA2']);
    expect(assignArgumentKeys('affirmative', 0)).toEqual([]);
  });

  it('位置が負なら投げる', () => {
    expect(() => argumentKeyAt('affirmative', -1)).toThrow(/0以上の整数/);
  });

  it('スロットの陣営は席から決まる', () => {
    expect(slotSide(affirmativeConstructive)).toBe('affirmative');
    expect(slotSide(negativeConstructive)).toBe('negative');
  });
});

describe('立論から保存する論点を組み立てる（設計 §8.2 / §6.3）', () => {
  it('登場順に AD1・AD2 が振られ、origin_section はそのセクションになる', () => {
    const drafts = buildArgumentDrafts(
      affirmativeConstructive,
      inputOf('affirmative', twoArguments),
    );

    expect(drafts.map((draft) => draft.argumentKey)).toEqual(['AD1', 'AD2']);
    expect(drafts.map((draft) => draft.kind)).toEqual(['advantage', 'advantage']);
    expect(drafts.map((draft) => draft.label)).toEqual(['学習時間が増える', '教員の負担が減る']);
    expect(new Set(drafts.map((draft) => draft.originSection))).toEqual(
      new Set([affirmativeConstructive.sectionNo]),
    );
    expect(new Set(drafts.map((draft) => draft.state))).toEqual(new Set(['submitted']));
  });

  it('否定側は DA1 から振られる', () => {
    const drafts = buildArgumentDrafts(negativeConstructive, inputOf('negative', {
      arguments: twoArguments.arguments.map((entry) => ({ ...entry, evidenceCardIds: [] })),
    }));
    expect(drafts.map((draft) => draft.argumentKey)).toEqual(['DA1', 'DA2']);
    expect(drafts.map((draft) => draft.kind)).toEqual(['disadvantage', 'disadvantage']);
  });

  it('Constructive 以外のスロットからは組み立てられない（設計 §6.3）', () => {
    for (const kind of ['attack', 'defense', 'summary', 'cx', 'prep'] as const) {
      expect(() =>
        buildArgumentDrafts(slotOf(kind), inputOf('affirmative', twoArguments)),
      ).toThrow(/Constructive/);
    }
  });
});

describe('speechText は固定テンプレートで組み立てる（設計 §8.3）', () => {
  it('肯定側は plan 行を含み、Evidence は指定順に1行ずつ出る', () => {
    const text = buildConstructiveSpeechText(
      'affirmative',
      inputOf('affirmative', {
        plan: 'プラン本文',
        arguments: [
          { label: '論点A', body: '本文A', evidenceCardIds: ['ev_001', 'ev_002'] },
          { label: '論点B', body: '本文B' },
        ],
      }),
      cards,
    );

    expect(text).toBe(
      [
        '私は論題に賛成します。',
        '【プラン】プラン本文',
        '【論点1：論点A】本文A',
        '（根拠：デモ資料A／2025-04「ダミー引用A」）',
        '（根拠：デモ資料B／2025-06「ダミー引用B」）',
        '【論点2：論点B】本文B',
      ].join('\n'),
    );
  });

  it('plan が null なら行ごと省略され、否定側は「反対」になる', () => {
    const text = buildConstructiveSpeechText(
      'negative',
      inputOf('negative', { arguments: [{ label: '論点C', body: '本文C' }] }),
      cards,
    );
    expect(text).toBe(['私は論題に反対します。', '【論点1：論点C】本文C'].join('\n'));
    expect(text).not.toContain('【プラン】');
  });

  it('同じ入力からは常に同じ本文が出る', () => {
    const input = inputOf('affirmative', twoArguments);
    const texts = Array.from({ length: 10 }, () =>
      buildConstructiveSpeechText('affirmative', input, cards),
    );
    expect(new Set(texts).size).toBe(1);
  });

  it('未検証の Evidence が混じっていたら投げる（黙って行を落とさない）', () => {
    const input = inputOf('affirmative', {
      arguments: [{ label: '論点A', body: '本文A', evidenceCardIds: ['ev_unknown'] }],
    });
    expect(() => buildConstructiveSpeechText('affirmative', input, cards)).toThrow(/未知の Evidence/);
  });
});

describe('Evidence の検証（設計 §8.2）', () => {
  it('match に存在するカードだけを許す', () => {
    const issues = validateEvidenceSelection(
      'affirmative',
      inputOf('affirmative', {
        arguments: [{ label: '論点A', body: '本文A', evidenceCardIds: ['ev_001', 'ev_missing'] }],
      }),
      cards,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('arguments.0.evidenceCardIds.1');
    expect(issues[0]?.message).toMatch(/存在しない/);
  });

  it('side が一致しないカードを棄却する', () => {
    const issues = validateEvidenceSelection(
      'affirmative',
      inputOf('affirmative', {
        arguments: [{ label: '論点A', body: '本文A', evidenceCardIds: ['ev_003'] }],
      }),
      cards,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/side が立論と一致しない/);
  });

  it('正しい指定なら issue は無い', () => {
    expect(
      validateEvidenceSelection('affirmative', inputOf('affirmative', twoArguments), cards),
    ).toEqual([]);
  });
});

describe('論点在庫はフォールバック判定と同じ出所を見る（設計 §9 / §10）', () => {
  const rows = [
    { argumentKey: 'DA2', side: 'negative' as const },
    { argumentKey: 'AD1', side: 'affirmative' as const },
    { argumentKey: 'DA1', side: 'negative' as const },
  ];

  it('side ごとに key 昇順で返す（保存順に左右されない）', () => {
    expect(argumentInventoryOf(rows)).toEqual({
      affirmative: ['AD1'],
      negative: ['DA1', 'DA2'],
    });
  });

  it('立論が入ると、そのCXは固定質問へ落ちない（設計 §10）', () => {
    const cxSlot = slotOf('cx');
    const emptyInventory = argumentInventoryOf([]);
    const filledInventory = argumentInventoryOf([
      { argumentKey: 'AD1', side: 'affirmative' },
      { argumentKey: 'DA1', side: 'negative' },
    ]);

    const decide = (args: ReturnType<typeof argumentInventoryOf>) =>
      decideSlotAction(fixtureRuleSet, cxSlot, {
        args,
        seats: defaultSeats,
        cxPhase: 'question',
      });

    expect(decide(emptyInventory)).toBe('cx_no_argument');
    expect(decide(filledInventory)).toBe('need_ai');
  });
});
