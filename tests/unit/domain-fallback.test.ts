import { describe, expect, it } from 'vitest';

import { decideJudgeOutcome, decideSlotAction, type ArgumentCounts } from '@/domain/fallback';
import { seatSide, type Seat, type SlotKind } from '@/schemas/common';
import type { RuleSlot } from '@/schemas/rule-set';

import { ruleSet, seats } from '../helpers/match-fixture';

/**
 * 論点0件のときのフォールバック判定（設計 §10）。
 * どの経路に入るべきかだけを返す。固定文とCX固定質問の実体は P8 で扱う。
 */

const NONE: ArgumentCounts = { affirmative: 0, negative: 0 };
const BOTH: ArgumentCounts = { affirmative: 2, negative: 2 };

/** セクション番号ではなく kind と席で引く（CLAUDE.md: 競技順序をコードに書かない） */
function slotOf(kind: SlotKind, actorSeat?: Seat): RuleSlot {
  const slot = ruleSet.slots.find(
    (entry) => entry.kind === kind && (actorSeat === undefined || entry.actorSeat === actorSeat),
  );
  if (slot === undefined) {
    throw new Error(`該当スロットが無い（kind=${kind}, actorSeat=${actorSeat ?? '指定なし'}）`);
  }
  return slot;
}

function decide(slot: RuleSlot, counts: ArgumentCounts, cxPhase: 'question' | 'answer' | null) {
  return decideSlotAction(ruleSet, { slot, cxPhase, argumentCounts: counts, seats });
}

describe('通常系では担当席の occupantType で決まる（設計 §11）', () => {
  it('人間の席は need_human', () => {
    const decision = decide(slotOf('constructive', 'A1'), BOTH, null);
    expect(decision.action).toBe('need_human');
    expect(decision.reason).toBeNull();
  });

  it('AIの席は need_ai', () => {
    const decision = decide(slotOf('constructive', 'N1'), BOTH, null);
    expect(decision.action).toBe('need_ai');
  });

  it('通常系ではフォールバックに落ちない', () => {
    for (const slot of ruleSet.slots.filter((entry) => entry.kind !== 'prep')) {
      const phases = slot.kind === 'cx' ? (['question', 'answer'] as const) : ([null] as const);
      for (const phase of phases) {
        const decision = decide(slot, BOTH, phase);
        expect(decision.action, `slot=${slot.key}, phase=${phase ?? 'なし'}`).toMatch(
          /^need_(human|ai)$/,
        );
        expect(decision.reason).toBeNull();
        expect(decision.headingToAbortNoContent).toBe(false);
      }
    }
  });
});

describe('CX: 質問対象の論点が0件（設計 §10 第2セクション）', () => {
  const cxSlot = slotOf('cx');

  it('質問側は固定質問へ切り替える', () => {
    const questionedSide = seatSide(cxSlot.respondentSeat ?? 'A1');
    const counts: ArgumentCounts =
      questionedSide === 'affirmative'
        ? { affirmative: 0, negative: 2 }
        : { affirmative: 2, negative: 0 };

    const decision = decide(cxSlot, counts, 'question');
    expect(decision.action).toBe('cx_no_argument');
    expect(decision.reason).toBe('cx_no_argument');
  });

  it('回答側は通常どおり担当席で決まる（回答者は人間のままである）', () => {
    const decision = decide(cxSlot, { affirmative: 0, negative: 2 }, 'answer');
    expect(decision.action).toBe('need_human');
    expect(decision.reason).toBeNull();
  });

  it('反論を対象とするCXは、立論0件でも通常どおり進む（設計 §17 の実行回数と一致する）', () => {
    // 回答席の直前のスピーチが attack であるCX。反論という対象があるため固定質問には落ちない
    const cxOverAttack = ruleSet.slots.find((entry) => {
      if (entry.kind !== 'cx') return false;
      const earlier = ruleSet.slots.filter(
        (other) =>
          other.index < entry.index &&
          other.kind !== 'cx' &&
          other.kind !== 'prep' &&
          other.actorSeat === entry.respondentSeat,
      );
      return earlier[earlier.length - 1]?.kind === 'attack';
    });
    expect(cxOverAttack).toBeDefined();
    if (cxOverAttack === undefined) return;

    expect(decide(cxOverAttack, NONE, 'question').action).toBe('need_ai');
  });

  it('cxPhase を渡さないと投げる', () => {
    expect(() => decide(cxSlot, BOTH, null)).toThrow(/cxPhase/);
  });
});

describe('Attack / Defense: 対象の論点が0件（設計 §10）', () => {
  it('Attack は相手側が0件なら自動充填', () => {
    const attack = slotOf('attack');
    const targetSide = seatSide(attack.actorSeat ?? 'A1') === 'affirmative' ? 'negative' : 'affirmative';
    const counts: ArgumentCounts =
      targetSide === 'affirmative' ? { affirmative: 0, negative: 2 } : { affirmative: 2, negative: 0 };

    const decision = decide(attack, counts, null);
    expect(decision.action).toBe('auto_fill');
    expect(decision.reason).toBe('skipped_no_target');
  });

  it('Attack は相手側に論点があれば通常どおり進む', () => {
    expect(decide(slotOf('attack'), BOTH, null).action).toBe('need_ai');
  });

  it('Defense は自陣が0件なら自動充填', () => {
    const defense = slotOf('defense');
    const ownSide = seatSide(defense.actorSeat ?? 'A1');
    const counts: ArgumentCounts =
      ownSide === 'affirmative' ? { affirmative: 0, negative: 2 } : { affirmative: 2, negative: 0 };

    const decision = decide(defense, counts, null);
    expect(decision.action).toBe('auto_fill');
    expect(decision.reason).toBe('skipped_no_target');
  });
});

describe('Summary: 片側0件と両側0件（設計 §10）', () => {
  const summary = slotOf('summary');

  it('片側0件でも通常どおり進み、比較が空になることを許す', () => {
    const decision = decide(summary, { affirmative: 0, negative: 2 }, null);
    expect(decision.action).toBe('need_ai');
    expect(decision.reason).toBe('summary_one_side_empty');
    expect(decision.allowEmptyComparisons).toBe(true);
  });

  it('両側0件では入力が無いためAIを呼ばない', () => {
    const decision = decide(summary, NONE, null);
    expect(decision.action).toBe('auto_fill');
    expect(decision.allowEmptyComparisons).toBe(true);
    expect(decision.headingToAbortNoContent).toBe(true);
  });
});

describe('両側0件は aborted_no_content へ向かう（設計 §10 判定行）', () => {
  it('どのスロットでも headingToAbortNoContent が立つ', () => {
    for (const slot of ruleSet.slots.filter((entry) => entry.kind !== 'prep')) {
      const phase = slot.kind === 'cx' ? 'question' : null;
      expect(decide(slot, NONE, phase).headingToAbortNoContent).toBe(true);
    }
  });

  it('判定は両側0件のときだけ aborted_no_content になる', () => {
    expect(decideJudgeOutcome(NONE)).toBe('aborted_no_content');
    expect(decideJudgeOutcome({ affirmative: 0, negative: 1 })).toBe('judged');
    expect(decideJudgeOutcome({ affirmative: 1, negative: 0 })).toBe('judged');
    expect(decideJudgeOutcome(BOTH)).toBe('judged');
  });
});

describe('準備スロットは判定の対象外（設計 §11）', () => {
  it('渡されたら投げる', () => {
    expect(() => decide(slotOf('prep'), BOTH, null)).toThrow(/準備スロット/);
  });
});
