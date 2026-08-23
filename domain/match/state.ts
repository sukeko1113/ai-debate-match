import type { MatchStatus, Seat } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

import type { CxState } from '../cx';
import type { SeatAssignment } from '../rules';

/**
 * 試合の進行状態（設計 §11 / §13 / 付録B）。
 *
 * ここに入るのは「サーバだけが決めてよいもの」である。
 * `status` / `currentSlotIndex` / `version` / CXの往復位置は client から確定させない
 * （CLAUDE.md の禁止事項）。
 *
 * 発話本文・論点・Evidence はここには持たない。それらは Repository の領分であり、
 * 状態機械は位置だけを決める。
 */

/** 各スロットの進行状態（設計 付録B progress） */
export type SlotProgressStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped_no_target';

/** 進行が終わったスロットの状態。ADVANCE はこの2つのときだけ許可する（設計 §11） */
const FINISHED_SLOT_STATUSES: readonly SlotProgressStatus[] = ['done', 'skipped_no_target'];

export function isSlotFinished(status: SlotProgressStatus): boolean {
  return FINISHED_SLOT_STATUSES.includes(status);
}

/** 判定・中断済みで、これ以上どの event も受け付けない状態（設計 §11） */
const TERMINAL_STATUSES: readonly MatchStatus[] = ['judged', 'aborted', 'aborted_no_content'];

export function isTerminalStatus(status: MatchStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type MatchState = {
  readonly id: string;
  /** 進行・時間・席割りの正（設計 §6.1）。試合ごとに凍結される */
  readonly ruleSet: RuleSet;
  /** 8席ちょうど（設計 §13 match_seats） */
  readonly seats: readonly SeatAssignment[];
  /** 設計 §13 matches.motion_id / motion_ja_snapshot に相当する最小の写し */
  readonly motion: { readonly code: string; readonly textJa: string };
  readonly status: MatchStatus;
  /** 0..(slots.length - 1)。client は次番号を指定しない（設計 §6.3） */
  readonly currentSlotIndex: number;
  /** 状態が変わるたびに +1（設計 §11 楽観ロック） */
  readonly version: number;
  /** CXスロットのときだけ非 null（設計 §7 / §13 match_slots） */
  readonly cx: CxState | null;
  /** rule set の slots と同じ長さ・同じ並び */
  readonly slotStatuses: readonly SlotProgressStatus[];
  /** ABORT の理由。設計 §11 で必須 */
  readonly abortReason: string | null;
};

export type CreateMatchStateInput = {
  readonly id: string;
  readonly ruleSet: RuleSet;
  readonly seats: readonly SeatAssignment[];
  readonly motion: { readonly code: string; readonly textJa: string };
};

/** 作成直後の試合。設計 §11 の起点である draft から始まる */
export function createMatchState(input: CreateMatchStateInput): MatchState {
  return {
    id: input.id,
    ruleSet: input.ruleSet,
    seats: input.seats,
    motion: input.motion,
    status: 'draft',
    currentSlotIndex: 0,
    version: 1,
    cx: null,
    slotStatuses: input.ruleSet.slots.map(() => 'pending'),
    abortReason: null,
  };
}

/** 現在スロット。範囲外なら null */
export function currentSlot(state: MatchState): RuleSlot | null {
  return state.ruleSet.slots[state.currentSlotIndex] ?? null;
}

/** 現在スロットの進行状態。範囲外なら null */
export function currentSlotStatus(state: MatchState): SlotProgressStatus | null {
  return state.slotStatuses[state.currentSlotIndex] ?? null;
}

/** 最終スロットにいるか（設計 §11 ADVANCE の分岐） */
export function isLastSlot(state: MatchState): boolean {
  return state.currentSlotIndex >= state.ruleSet.slots.length - 1;
}

/** いま担当している席。準備スロットは担当席を持たない（設計 §7 / §11） */
export function responsibleSeatOf(state: MatchState): Seat | null {
  const slot = currentSlot(state);
  if (slot === null) return null;
  if (slot.kind !== 'cx') return slot.actorSeat;
  if (state.cx === null) return null;
  return state.cx.phase === 'question' ? slot.actorSeat : slot.respondentSeat;
}
