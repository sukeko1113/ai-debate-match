import type { Seat } from '@/schemas/common';

/**
 * 永続化する行の形（設計 §13 データ契約）。
 *
 * 列名は snake_case（SQL）だが、TypeScript 側は camelCase に揃える。
 * Postgres adapter を足すときは、この形へ写す責務が adapter 側にある。
 *
 * ここは interface とデータの形だけを持つ。実装は infrastructure に置く（設計 §12.1）。
 */

/** その発話が誰の手によるか。auto_fill は固定文（設計 §10.2） */
export type SpeechSource = 'human' | 'ai' | 'auto_fill';

/** 設計 §13 speeches */
export type SpeechRecord = {
  readonly id: string;
  readonly matchId: string;
  /** CX以外の競技セクション番号。UNIQUE(match_id, section_no) */
  readonly sectionNo: number;
  readonly seat: Seat;
  readonly source: SpeechSource;
  readonly text: string;
  readonly structuredJson: unknown;
  /** 時間切れで未提出のときは false（設計 §11 HUMAN_TIMEOUT） */
  readonly submitted: boolean;
  /** 固定文で埋めたときに true（設計 §10.2） */
  readonly autoFilled: boolean;
};

/** 設計 §13 cx_turns。質問と回答は同じ行の別列である（設計 §7） */
export type CxTurnRecord = {
  readonly id: string;
  readonly matchId: string;
  /** CXセクション番号。UNIQUE(match_id, section_no, turn_index) */
  readonly sectionNo: number;
  /** 0 起点の往復位置。cx_turn_cursor と同じ値 */
  readonly turnIndex: number;
  readonly askedBySeat: Seat;
  readonly answeredBySeat: Seat;
  readonly questionText: string;
  /** 回答の確定前は null（設計 §7） */
  readonly answerText: string | null;
  /** 論点0件のCXでは null を許可する（設計 §10） */
  readonly targetArgumentKey: string | null;
  /** 持ち時間切れで打ち切った往復（設計 §7） */
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

/** 設計 §13 ai_runs */
export type AiRunRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly slotIndex: number;
  /** CX以外のスロットでは null（設計 §13.1 で COALESCE(-1) して索引を張る列） */
  readonly cxTurnIndex: number | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  /** 1 run あたりの試行番号（設計 §22 MAX_AI_RETRIES_PER_RUN） */
  readonly attempt: number;
  readonly status: string;
  readonly outputJson: unknown;
  readonly usageJson: unknown;
  readonly errorCode: string | null;
};

/** 設計 §13 audit_logs。追記のみ */
export type AuditLogRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  /** ISO8601。時計は Repository の側にある（設計 §11 reducer は純関数） */
  readonly createdAt: string;
};
