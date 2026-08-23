import { seatSchema, type Seat, type SlotKind } from '../common';

/**
 * 設計 §6.1 の集計表を、そのまま定数にしたもの。
 * この値は競技ルールの正であり、テストやUIの都合で変えてはならない。
 */

/** 競技セクションは no=1〜12 のちょうど12件 */
export const COMPETITION_SECTION_COUNT = 12;

/** 準備スロットはちょうど5件 */
export const PREP_SLOT_COUNT = 5;

/** 準備時間の合計（秒） */
export const PREP_TOTAL_SECONDS = 480;

/** 12セクションの合計（秒） */
export const COMPETITION_TOTAL_SECONDS = 2040;

/** 主スピーチの種別。CXと準備を除いた4種（設計 §6.1） */
export const MAIN_SPEECH_KINDS: readonly SlotKind[] = [
  'constructive',
  'attack',
  'defense',
  'summary',
];

/** 8席すべて。主スピーチは各席ちょうど1回（設計 §6.1） */
export const ALL_SEATS: readonly Seat[] = seatSchema.options;

/** CXで質問する席（設計 §6.1 / §6.2） */
export const CX_ACTOR_SEATS: readonly Seat[] = ['N4', 'A4', 'A3', 'N3'];

/** CXで回答する席（設計 §6.1 / §6.2） */
export const CX_RESPONDENT_SEATS: readonly Seat[] = ['A1', 'N1', 'N2', 'A2'];

/** 集合の一致を、順序を無視して比較するための正規化 */
export function sortedSeats(seats: readonly Seat[]): Seat[] {
  return [...seats].sort();
}
