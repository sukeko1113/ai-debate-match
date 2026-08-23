import { describe, expect, it } from 'vitest';

import {
  allowEmptyComparisons,
  decideJudgeOutcome,
  decideSlotAction,
  EMPTY_ARGUMENT_INVENTORY,
  type SlotDecisionInput,
} from '@/domain/fallback';
import type { RuleSlot } from '@/schemas/rule-set';

import {
  affirmativeOnlyArguments,
  allAiSeats,
  bothSidesArguments,
  defaultSeats,
  fixtureRuleSet,
  negativeOnlyArguments,
  noArguments,
} from '../support/match-fixtures';

/**
 * 論点0件のときのフォールバック判定（設計 §10）。
 * ここが返すのは経路だけで、固定文と固定質問の実体は P8 が入れる。
 */

function slotOf(sectionNo: number): RuleSlot {
  const slot = fixtureRuleSet.slots.find((entry) => entry.sectionNo === sectionNo);
  if (slot === undefined) throw new Error(`section ${sectionNo} が rule set に無い`);
  return slot;
}

function input(overrides: Partial<SlotDecisionInput>): SlotDecisionInput {
  return {
    args: bothSidesArguments,
    seats: defaultSeats,
    cxPhase: null,
    ...overrides,
  };
}

describe('通常時（両側に論点がある）はフォールバックしない（設計 §10）', () => {
  it.each([
    { sectionNo: 1, seat: 'A1', expected: 'need_human' },
    { sectionNo: 3, seat: 'N1', expected: 'need_ai' },
    { sectionNo: 5, seat: 'N2', expected: 'need_ai' },
    { sectionNo: 7, seat: 'A2', expected: 'need_ai' },
    { sectionNo: 9, seat: 'A3', expected: 'need_ai' },
    { sectionNo: 10, seat: 'N3', expected: 'need_ai' },
    { sectionNo: 11, seat: 'A4', expected: 'need_ai' },
    { sectionNo: 12, seat: 'N4', expected: 'need_ai' },
  ])('第$sectionNoセクション（$seat）は $expected', ({ sectionNo, expected }) => {
    expect(decideSlotAction(fixtureRuleSet, slotOf(sectionNo), input({}))).toBe(expected);
  });

  it('CXは質問も回答も担当席の種別で決まる', () => {
    // 第2セクション: 質問 N4（AI）／回答 A1（人間）
    const slot = slotOf(2);
    expect(decideSlotAction(fixtureRuleSet, slot, input({ cxPhase: 'question' }))).toBe('need_ai');
    expect(decideSlotAction(fixtureRuleSet, slot, input({ cxPhase: 'answer' }))).toBe('need_human');
  });
});

describe('CX: 回答側の論点が0件なら cx_no_argument（設計 §10 / §10.1）', () => {
  it('第2セクションで肯定側が0件なら質問は cx_no_argument', () => {
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(2), input({ args: noArguments, cxPhase: 'question' })),
    ).toBe('cx_no_argument');
  });

  it('回答は通常どおり担当席が行う。置き換わるのは質問だけである', () => {
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(2), input({ args: noArguments, cxPhase: 'answer' })),
    ).toBe('need_human');
  });

  it('肯定側に論点があれば通常の経路へ戻る', () => {
    expect(
      decideSlotAction(
        fixtureRuleSet,
        slotOf(2),
        input({ args: affirmativeOnlyArguments, cxPhase: 'question' }),
      ),
    ).toBe('need_ai');
  });

  it('第4セクション（回答は否定側 N1）は否定側の論点で決まる', () => {
    expect(
      decideSlotAction(
        fixtureRuleSet,
        slotOf(4),
        input({ args: affirmativeOnlyArguments, cxPhase: 'question' }),
      ),
    ).toBe('cx_no_argument');
    expect(
      decideSlotAction(
        fixtureRuleSet,
        slotOf(4),
        input({ args: negativeOnlyArguments, cxPhase: 'question' }),
      ),
    ).toBe('need_ai');
  });
});

describe('Attack / Defense: 対象側が0件なら auto_fill（設計 §10）', () => {
  it('第5セクション 否定Attack は肯定側が0件のとき auto_fill', () => {
    expect(decideSlotAction(fixtureRuleSet, slotOf(5), input({ args: noArguments }))).toBe(
      'auto_fill',
    );
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(5), input({ args: affirmativeOnlyArguments })),
    ).toBe('need_ai');
  });

  it('第7セクション 肯定Attack は否定側が0件のとき auto_fill', () => {
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(7), input({ args: affirmativeOnlyArguments })),
    ).toBe('auto_fill');
  });

  it('第9セクション 肯定Defense は自陣が0件のとき auto_fill', () => {
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(9), input({ args: negativeOnlyArguments })),
    ).toBe('auto_fill');
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(9), input({ args: affirmativeOnlyArguments })),
    ).toBe('need_ai');
  });

  it('第10セクション 否定Defense は自陣が0件のとき auto_fill', () => {
    expect(
      decideSlotAction(fixtureRuleSet, slotOf(10), input({ args: affirmativeOnlyArguments })),
    ).toBe('auto_fill');
  });
});

describe('Summary は片側0件でも通常どおり進める（設計 §10）', () => {
  it.each([11, 12])('第%iセクションは片側0件でも need_ai', (sectionNo) => {
    expect(
      decideSlotAction(
        fixtureRuleSet,
        slotOf(sectionNo),
        input({ args: affirmativeOnlyArguments, seats: allAiSeats }),
      ),
    ).toBe('need_ai');
  });

  it('片側0件のときだけ、比較が空になることを許す', () => {
    expect(allowEmptyComparisons(bothSidesArguments)).toBe(false);
    expect(allowEmptyComparisons(affirmativeOnlyArguments)).toBe(true);
    expect(allowEmptyComparisons(negativeOnlyArguments)).toBe(true);
    expect(allowEmptyComparisons(noArguments)).toBe(true);
  });
});

describe('判定の経路（設計 §10）', () => {
  it('両側0件なら aborted_no_content へ向かう', () => {
    expect(decideJudgeOutcome(EMPTY_ARGUMENT_INVENTORY)).toBe('aborted_no_content');
  });

  it('片側でも論点があれば判定を実行する', () => {
    expect(decideJudgeOutcome(affirmativeOnlyArguments)).toBe('judged');
    expect(decideJudgeOutcome(negativeOnlyArguments)).toBe('judged');
    expect(decideJudgeOutcome(bothSidesArguments)).toBe('judged');
  });
});

describe('準備スロットには経路がない（設計 §11）', () => {
  it('prep を渡すと投げる', () => {
    const prep = fixtureRuleSet.slots.find((slot) => slot.kind === 'prep');
    expect(prep).toBeDefined();
    expect(() => decideSlotAction(fixtureRuleSet, prep!, input({}))).toThrow(/準備スロットに経路はない/);
  });
});
