import { startCxSlot, type CxState } from '@/domain/cx';
import { slotAt, type SeatAssignment } from '@/domain/rules';
import type { MatchStatus } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

/**
 * 試合の進行状態（設計 §11 / §13 matches・match_slots / 付録B）。
 *
 * 進行位置を決めてよいのはサーバだけである。client は currentSlotIndex も
 * cxTurnCursor も送ってこない（CLAUDE.md 禁止事項）。
 *
 * DB 行ではなくドメインの集約として持つため、検証済み rule set をそのまま抱える。
 * 状態遷移が rule set を引数で受け取らずに完結し、reducer の純粋性が保てる。
 */

/** スロット単位の進行状況（設計 付録B progress） */
export type SlotProgressStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped_no_target';

export type MatchState = {
  readonly id: string;
  readonly ruleSet: RuleSet;
  readonly status: MatchStatus;
  /** 進行配列の現在位置。サーバのみが進める（設計 §6.3） */
  readonly currentSlotIndex: number;
  /** 状態が変わるたびに +1（設計 §11 楽観ロック） */
  readonly version: number;
  /** 8席の席割り。CONFIGURE で確定する */
  readonly seats: readonly SeatAssignment[];
  /** rule set の slots と同じ長さ */
  readonly slotStatuses: readonly SlotProgressStatus[];
  /** CXスロットにいるときだけ非null（設計 §13 match_slots） */
  readonly cx: CxState | null;
  /** ABORT の理由（設計 §11 ABORT 行） */
  readonly abortReason: string | null;
};

/** ここから先へは進めない状態（設計 §11） */
export const TERMINAL_STATUSES: readonly MatchStatus[] = ['judged', 'aborted', 'aborted_no_content'];

export function isTerminalStatus(status: MatchStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** ABORT を受け付ける状態（設計 §11「任意の非終端」） */
export const NON_TERMINAL_STATUSES: readonly MatchStatus[] = [
  'draft',
  'ready',
  'active',
  'prep_running',
  'waiting_human',
  'generating_ai',
  'paused',
  'completed',
];

export function createMatchState(params: { id: string; ruleSet: RuleSet }): MatchState {
  return {
    id: params.id,
    ruleSet: params.ruleSet,
    status: 'draft',
    currentSlotIndex: 0,
    version: 0,
    seats: [],
    slotStatuses: params.ruleSet.slots.map(() => 'pending'),
    cx: null,
    abortReason: null,
  };
}

/** 現在スロット。範囲外は null */
export function currentSlot(state: MatchState): RuleSlot | null {
  return slotAt(state.ruleSet, state.currentSlotIndex);
}

export function slotProgress(state: MatchState, index: number): SlotProgressStatus {
  return state.slotStatuses[index] ?? 'pending';
}

/** そのスロットの出力が確定しているか（設計 §11 ADVANCE 行の条件） */
export function isSlotResolved(state: MatchState, index: number): boolean {
  const status = slotProgress(state, index);
  return status === 'done' || status === 'skipped_no_target';
}

export function withStatus(state: MatchState, status: MatchStatus): MatchState {
  return { ...state, status };
}

export function withSlotStatus(
  state: MatchState,
  index: number,
  status: SlotProgressStatus,
): MatchState {
  return {
    ...state,
    slotStatuses: state.slotStatuses.map((current, position) =>
      position === index ? status : current,
    ),
  };
}

export function withCx(state: MatchState, cx: CxState | null): MatchState {
  return { ...state, cx };
}

/**
 * 指定スロットへ入る。CXスロットなら副状態を初期化する（設計 §7 開始）。
 * 進行位置の更新はこの関数だけが行う。
 */
export function enterSlot(state: MatchState, index: number): MatchState {
  const slot = slotAt(state.ruleSet, index);
  if (slot === null) {
    throw new Error(`進行配列の範囲外へ進もうとした（index=${index}）。設計 §6.1`);
  }
  return withCx(
    withSlotStatus({ ...state, currentSlotIndex: index }, index, 'active'),
    slot.kind === 'cx' ? startCxSlot() : null,
  );
}
