import type { CxPhase, Seat } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

/**
 * rule set の照会（設計 §6.1 / §6.2 / §7）。
 * 純関数のみ。React・fetch・DB client・process.env を import しない（設計 §12.1）。
 *
 * 検証済みの rule set は index が配列位置と一致することが保証されている
 * （`schemas/rule-set` の index 連番検証）。よって添字引きで足りる。
 */

/** 指定インデックスのスロット。範囲外は null */
export function slotAt(ruleSet: RuleSet, index: number): RuleSlot | null {
  return ruleSet.slots[index] ?? null;
}

/** 次のスロット。最終スロットなら null */
export function nextSlot(ruleSet: RuleSet, currentIndex: number): RuleSlot | null {
  return slotAt(ruleSet, currentIndex + 1);
}

/** セクション番号からスロットを引く。準備スロットは sectionNo を持たないため引けない */
export function sectionSlot(ruleSet: RuleSet, sectionNo: number): RuleSlot | null {
  return ruleSet.slots.find((slot) => slot.sectionNo === sectionNo) ?? null;
}

/**
 * そのスロットで「いま担当している席」を返す。
 *
 * - CX以外: actorSeat（準備スロットは担当席がないため null）
 * - CX: cxPhase=question なら質問席、answer なら回答席（設計 §7）
 *
 * CXスロットは cxPhase なしでは担当席が決まらない。省略された場合は投げる。
 */
export function responsibleSeat(
  ruleSet: RuleSet,
  index: number,
  cxPhase: CxPhase | null = null,
): Seat | null {
  const slot = slotAt(ruleSet, index);
  if (slot === null) return null;
  if (slot.kind !== 'cx') return slot.actorSeat;

  if (cxPhase === null) {
    throw new Error(
      `CXスロットの担当席を決めるには cxPhase が必要である（index=${index}, key=${slot.key}）。設計 §7`,
    );
  }
  return cxPhase === 'question' ? slot.actorSeat : slot.respondentSeat;
}
