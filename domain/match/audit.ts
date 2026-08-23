import type { MatchEventType } from './events';

/**
 * 監査イベント（設計 §13 audit_logs / §10.2）。
 *
 * 状態機械は書き込みを行わない。何を追記すべきかを配列で返すだけである。
 * `created_at` はここでは付けない。時計を持たないことで reducer が純関数のままになり、
 * 同じ入力から常に同じ結果が出る（設計 §15.7 の決定性と同じ理由）。
 * 時刻は Repository が追記時に付ける。
 */

/** 誰がその変更を起こしたか（設計 §13 audit_logs.actor） */
export type AuditActor = 'server' | 'human' | 'ai';

export type AuditEvent = {
  readonly matchId: string;
  readonly eventType: MatchEventType;
  readonly actor: AuditActor;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** 人間の操作に由来する event（設計 §11） */
const HUMAN_EVENTS: readonly MatchEventType[] = ['HUMAN_SUBMIT', 'HUMAN_TIMEOUT'];

/** AI 実行に由来する event（設計 §11） */
const AI_EVENTS: readonly MatchEventType[] = ['AI_SUCCEEDED', 'AI_FAILED'];

export function auditActorFor(eventType: MatchEventType): AuditActor {
  if (HUMAN_EVENTS.includes(eventType)) return 'human';
  if (AI_EVENTS.includes(eventType)) return 'ai';
  return 'server';
}
