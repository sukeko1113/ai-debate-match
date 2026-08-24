import type { MatchEvent, MatchEventType } from './events';
import type { MatchState } from './state';

/**
 * 監査イベント（設計 §13 audit_logs）。
 *
 * reducer は書き込みを行わない。状態が変わるたびに、書き込むべきイベントを
 * 戻り値として返すだけである。created_at は書き込み側が付ける。
 * 純関数に時刻を持ち込まないため、ここでは持たない。
 */

/** 設計 §13 の audit_logs.actor。Phase 1 は3種で足りる */
export type AuditActor = 'human' | 'ai' | 'server';

/** イベントそのものに加えて記録する、派生した事実 */
export type DerivedAuditEventType =
  | 'SLOT_COMPLETED'
  | 'SLOT_AUTO_FILLED'
  | 'CX_TURN_ADVANCED'
  | 'MATCH_COMPLETED';

export type AuditLogEntry = {
  readonly eventType: MatchEventType | DerivedAuditEventType;
  readonly actor: AuditActor;
  readonly payload: Readonly<Record<string, unknown>>;
};

/**
 * どの主体が起こしたイベントかを固定する。
 *
 * client から呼ばれるAPIに対応するイベントは human、AIの実行結果は ai、
 * サーバが自分の判断で起こすものは server とする。
 * 設計は actor の語彙を定義していないため、この3分類を Phase 1 の約束とする。
 */
const ACTOR_BY_EVENT: Readonly<Record<MatchEventType, AuditActor>> = {
  CONFIGURE: 'human',
  START: 'human',
  ENTER_PREP: 'server',
  PREP_ELAPSED: 'server',
  SKIP_PREP: 'human',
  NEED_HUMAN: 'server',
  NEED_AI: 'server',
  AUTO_FILL: 'server',
  HUMAN_SUBMIT: 'human',
  HUMAN_TIMEOUT: 'server',
  AI_SUCCEEDED: 'ai',
  AI_FAILED: 'ai',
  RETRY_AI: 'human',
  ADVANCE: 'human',
  JUDGE: 'human',
  ABORT: 'human',
};

export function auditActorOf(eventType: MatchEventType): AuditActor {
  return ACTOR_BY_EVENT[eventType];
}

/** 遷移そのものの記録。from / to は状態機械の実際の遷移を書く */
export function transitionLog(
  before: MatchState,
  after: MatchState,
  event: MatchEvent,
): AuditLogEntry {
  return {
    eventType: event.type,
    actor: auditActorOf(event.type),
    payload: {
      from: before.status,
      to: after.status,
      slotIndex: after.currentSlotIndex,
    },
  };
}

/** 派生した事実の記録。actor は常に server（サーバが確定させた事実である） */
export function derivedLog(
  eventType: DerivedAuditEventType,
  payload: Readonly<Record<string, unknown>>,
): AuditLogEntry {
  return { eventType, actor: 'server', payload };
}

/** 監査イベントに、確定後の version を書き込む（設計 §11 楽観ロック） */
export function stampVersion(
  entries: readonly AuditLogEntry[],
  version: number,
): readonly AuditLogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    payload: { ...entry.payload, version },
  }));
}
