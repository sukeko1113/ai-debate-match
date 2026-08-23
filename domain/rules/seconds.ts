import type { SlotKind } from '@/schemas/common';
import type { RuleSet } from '@/schemas/rule-set';

/**
 * 時間の集計（設計 §6.1 / §6.4）。
 * 表示に使うのは常に rule set の seconds であり、component が持つ定数ではない。
 */

function sumSeconds(ruleSet: RuleSet, include: (kind: SlotKind) => boolean): number {
  return ruleSet.slots.reduce((acc, slot) => (include(slot.kind) ? acc + slot.seconds : acc), 0);
}

/** 全スロットの合計秒数（検証済みなら declaredTotalSeconds と一致する） */
export function totalSeconds(ruleSet: RuleSet): number {
  return sumSeconds(ruleSet, () => true);
}

/** 12の競技セクションの合計秒数 */
export function competitionSeconds(ruleSet: RuleSet): number {
  return sumSeconds(ruleSet, (kind) => kind !== 'prep');
}

/** 準備スロットの合計秒数 */
export function prepSeconds(ruleSet: RuleSet): number {
  return sumSeconds(ruleSet, (kind) => kind === 'prep');
}
