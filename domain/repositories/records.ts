import { startCxSlot, type CxMode, type CxState } from '@/domain/cx';
import type { MatchState, SlotProgressStatus } from '@/domain/match';
import type { AuditActor } from '@/domain/match';
import type { CxPhase, MatchStatus, Seat } from '@/schemas/common';
import type { RuleSet } from '@/schemas/rule-set';

/**
 * 永続化する行の形（設計 §13）。
 *
 * Phase 1 の既定は Memory Repository だが、列と一意性は Postgres へそのまま移せる形で
 * 定義する。id と created_at は呼び出し側が与える。Repository は時刻もIDも作らない。
 */

/** 設計 §13 matches ＋ match_slots のうち、進行に必要な列 */
export type MatchRecord = {
  readonly id: string;
  readonly ruleSetCode: string;
  readonly motionCode: string;
  readonly status: MatchStatus;
  readonly currentSlotIndex: number;
  readonly version: number;
  /** kind=cx のスロットにいるときだけ非null（設計 §13 match_slots） */
  readonly cxPhase: CxPhase | null;
  readonly cxTurnCursor: number | null;
  readonly cxMode: CxMode | null;
  readonly cxTruncated: boolean;
  readonly slotStatuses: readonly SlotProgressStatus[];
  readonly abortReason: string | null;
};

/** 設計 §13 speeches。UNIQUE(match_id, section_no) */
export type SpeechRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly sectionNo: number;
  readonly seat: Seat;
  readonly source: 'human' | 'ai';
  readonly text: string;
  readonly structuredJson: unknown;
  readonly submitted: boolean;
  /** 固定文で埋めた（設計 §10.2） */
  readonly autoFilled: boolean;
};

/** 設計 §13 cx_turns。UNIQUE(match_id, section_no, turn_index) */
export type CxTurnRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly sectionNo: number;
  readonly turnIndex: number;
  readonly askedBySeat: Seat;
  readonly answeredBySeat: Seat;
  readonly questionText: string;
  readonly answerText: string | null;
  readonly targetArgumentKey: string | null;
  readonly truncated: boolean;
};

/** 設計 §13 evidence_uses。出典は speech か cx_turn のどちらか一方（設計 §13.1） */
export type EvidenceUseRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly speechId: string | null;
  readonly cxTurnId: string | null;
  readonly evidenceCardId: string;
  readonly argumentKey: string;
  readonly useType: string;
};

/** 設計 §15.1 の role */
export type AiRunRole =
  | 'constructive'
  | 'cx_question'
  | 'cx_answer'
  | 'attack'
  | 'defense'
  | 'summary'
  | 'judge';

/** 設計 §13 ai_runs。UNIQUE(match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt) */
export type AiRunRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly slotIndex: number;
  /** CX以外は null（設計 §13.1） */
  readonly cxTurnIndex: number | null;
  readonly role: AiRunRole;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly attempt: number;
  readonly status: 'succeeded' | 'failed';
};

/** 設計 §13 audit_logs。追記のみ */
export type AuditLogRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly eventType: string;
  readonly actor: AuditActor;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

/** 進行状態を matches / match_slots の行へ写す */
export function toMatchRecord(state: MatchState, motionCode: string): MatchRecord {
  return {
    id: state.id,
    ruleSetCode: state.ruleSet.code,
    motionCode,
    status: state.status,
    currentSlotIndex: state.currentSlotIndex,
    version: state.version,
    cxPhase: state.cx === null ? null : state.cx.phase,
    cxTurnCursor: state.cx === null ? null : state.cx.turnCursor,
    cxMode: state.cx === null ? null : state.cx.mode,
    cxTruncated: state.cx !== null && state.cx.truncated,
    slotStatuses: state.slotStatuses,
    abortReason: state.abortReason,
  };
}

/**
 * 行から進行状態を復元する。再読込・再試行のいずれでも同じ位置に戻るための経路である
 * （設計 §7 / E02）。席割りは match_seats から読むため引数で受け取る。
 */
export function restoreMatchState(
  record: MatchRecord,
  ruleSet: RuleSet,
  seats: MatchState['seats'],
): MatchState {
  const cx: CxState | null =
    record.cxPhase === null || record.cxTurnCursor === null
      ? null
      : {
          ...startCxSlot(record.cxMode ?? 'normal'),
          phase: record.cxPhase,
          turnCursor: record.cxTurnCursor,
          truncated: record.cxTruncated,
        };

  return {
    id: record.id,
    ruleSet,
    status: record.status,
    currentSlotIndex: record.currentSlotIndex,
    version: record.version,
    seats,
    slotStatuses: record.slotStatuses,
    cx,
    abortReason: record.abortReason,
  };
}
