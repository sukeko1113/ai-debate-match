import type { ApiErrorCode } from '@/schemas/api';

/**
 * 遷移が拒否された理由（設計 §14.4）。
 *
 * 状態機械が返すのはこの3コードだけである。
 * HTTP status への写像は application 層が行い、ここでは HTTP を知らない。
 *
 * | code | HTTP | 条件 |
 * | --- | --- | --- |
 * | INVALID_TRANSITION | 400 | 現在状態からその event が不可 |
 * | MATCH_VERSION_CONFLICT | 409 | expectedVersion 不一致 |
 * | SLOT_NOT_READY | 409 | 現在スロット未確定、またはCXの往復が未完 |
 */
export type TransitionErrorCode = Extract<
  ApiErrorCode,
  'INVALID_TRANSITION' | 'MATCH_VERSION_CONFLICT' | 'SLOT_NOT_READY'
>;

export type TransitionError = {
  readonly code: TransitionErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

export function transitionError(
  code: TransitionErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): TransitionError {
  return { code, message, details };
}
