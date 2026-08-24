import type { ApiErrorCode } from '@/schemas/api';

import type { AuditLogEntry } from './audit';
import type { MatchEvent } from './events';
import type { MatchState } from './state';

/**
 * 遷移の結果（設計 §11 / §14.4）。
 *
 * 状態機械が返すエラーコードは、設計 §14.4 の一覧に含まれる3種だけである。
 * 例外は投げない。遷移表にない組み合わせは必ず INVALID_TRANSITION になる。
 */
export type TransitionErrorCode = Extract<
  ApiErrorCode,
  'INVALID_TRANSITION' | 'SLOT_NOT_READY' | 'MATCH_VERSION_CONFLICT'
>;

export type TransitionError = {
  readonly ok: false;
  readonly code: TransitionErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

export type TransitionSuccess = {
  readonly ok: true;
  readonly state: MatchState;
  /** 書き込みは行わない。呼び出し側が audit_logs へ追記する（設計 §13） */
  readonly auditLogs: readonly AuditLogEntry[];
};

export type TransitionResult = TransitionSuccess | TransitionError;

function baseDetails(state: MatchState, event: MatchEvent): Record<string, unknown> {
  return {
    status: state.status,
    event: event.type,
    slotIndex: state.currentSlotIndex,
  };
}

/** 400 INVALID_TRANSITION: 現在状態からそのeventが不可（設計 §14.4） */
export function invalidTransition(
  state: MatchState,
  event: MatchEvent,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): TransitionError {
  return {
    ok: false,
    code: 'INVALID_TRANSITION',
    message: `${state.status} の状態で ${event.type} は実行できない: ${reason}`,
    details: { ...baseDetails(state, event), ...details },
  };
}

/** 409 SLOT_NOT_READY: 前slot未確定、またはCXの往復が未完（設計 §14.4） */
export function slotNotReady(
  state: MatchState,
  event: MatchEvent,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): TransitionError {
  return {
    ok: false,
    code: 'SLOT_NOT_READY',
    message: `現在スロットが未確定である: ${reason}`,
    details: { ...baseDetails(state, event), ...details },
  };
}

/** 409 MATCH_VERSION_CONFLICT: expectedVersion 不一致（設計 §11 / §14.4） */
export function versionConflict(state: MatchState, event: MatchEvent): TransitionError {
  return {
    ok: false,
    code: 'MATCH_VERSION_CONFLICT',
    message: '表示を更新して再試行してください。',
    details: {
      ...baseDetails(state, event),
      expectedVersion: event.expectedVersion,
      actualVersion: state.version,
    },
  };
}

export function isTransitionError(result: {
  ok: boolean;
}): result is TransitionError {
  return result.ok === false;
}
