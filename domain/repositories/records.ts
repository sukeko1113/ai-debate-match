import type { ArgumentKind, ArgumentState, Seat, Side } from '@/schemas/common';

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

/**
 * 設計 §13 arguments。UNIQUE(match_id, argument_key)。
 * 行が増えるのは Constructive のセクションだけである（設計 §6.3）。
 * `is_new_argument` は設計 §9.1 で廃止されたため、列を作らない。
 */
export type ArgumentRecord = {
  readonly id: string;
  readonly matchId: string;
  /** AD1 / AD2 / DA1 / DA2。採番はサーバのみが行う（設計 §8.2） */
  readonly argumentKey: string;
  readonly side: Side;
  /** side から決まる。クライアントとAIの指定は使わない（設計 §8.2） */
  readonly kind: ArgumentKind;
  readonly label: string;
  readonly body: string;
  /** 論点が生まれたセクション番号 */
  readonly originSection: number;
  readonly state: ArgumentState;
};

/** 設計 §13 evidence_cards。seed または手入力のみで、AI生成は禁止（設計 §15.6） */
export type EvidenceCardRecord = {
  readonly id: string;
  readonly matchId: string;
  readonly side: Side;
  readonly title: string;
  readonly sourceLabel: string;
  readonly publishedOn: string;
  readonly quote: string;
  readonly verificationStatus: string;
  readonly demoOnly: boolean;
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
  /** 質問が対象にした論点。論点0件のCXでは null（設計 §10 / §15.3） */
  readonly targetArgumentKey: string | null;
  /**
   * 回答で認めた論点（設計 §15.3 CX answer の concessionKey）。
   *
   * 設計 §13 の cx_turns には列が1つ（target_argument_key）しか無いが、
   * 質問の対象と回答の譲歩は別の事実である。1列に混ぜると、Attack の入力
   * （設計 §15.3 の cxConcessions）で「質問対象か譲歩か」を区別できない。
   */
  readonly concessionArgumentKey: string | null;
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

/**
 * 設計 §13 judging_runs。UNIQUE(match_id, rubric_version)。
 *
 * 同じ rubric で二度採点しない（設計 §21.2）。採点基準を変えたときだけ行が増える。
 */
export type JudgingRunRecord = {
  readonly id: string;
  readonly matchId: string;
  /** 採点基準の版。同じ版で二重に作らない */
  readonly rubricVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  /** 設計 §16.3 の match と newArgumentFindings */
  readonly resultJson: unknown;
  /** 設計 §16.3 の learnerReport */
  readonly learnerReportJson: unknown;
  readonly needsReview: boolean;
};
