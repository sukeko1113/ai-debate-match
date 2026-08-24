import type {
  AiRunRecord,
  AuditLogRecord,
  CxTurnRecord,
  EvidenceUseRecord,
  MatchRecord,
  SpeechRecord,
} from './records';

/**
 * Repository interface（設計 §12 / §12.1）。
 *
 * interface は domain 側に置き、実装（Memory / Postgres）だけ infrastructure に置く。
 * domain は infrastructure を import しない。
 *
 * 一意性違反・楽観ロック違反は `RepositoryError` で返す。どちらのadapterでも
 * 同じ code と constraint になること（設計 §13.1）。
 */

export interface MatchRepository {
  /** id が既にあれば UNIQUE_VIOLATION */
  create(record: MatchRecord): Promise<MatchRecord>;
  findById(id: string): Promise<MatchRecord | null>;
  /** version 不一致は VERSION_CONFLICT。保存後の version は呼び出し側が決める（設計 §11） */
  save(record: MatchRecord, expectedVersion: number): Promise<MatchRecord>;
}

export interface SpeechRepository {
  /** UNIQUE(match_id, section_no) */
  append(record: SpeechRecord): Promise<SpeechRecord>;
  listByMatch(matchId: string): Promise<readonly SpeechRecord[]>;
}

export interface CxTurnRepository {
  /** UNIQUE(match_id, section_no, turn_index) */
  append(record: CxTurnRecord): Promise<CxTurnRecord>;
  /** 同一 turn の行に answer_text を書く（設計 §7 回答の確定）。行が無ければ NOT_FOUND */
  saveAnswer(params: {
    matchId: string;
    sectionNo: number;
    turnIndex: number;
    answerText: string;
    truncated: boolean;
  }): Promise<CxTurnRecord>;
  listByMatch(matchId: string): Promise<readonly CxTurnRecord[]>;
}

export interface EvidenceUseRepository {
  /** speech_id と cx_turn_id はどちらか一方だけ（設計 §13.1） */
  append(record: EvidenceUseRecord): Promise<EvidenceUseRecord>;
  listByMatch(matchId: string): Promise<readonly EvidenceUseRecord[]>;
}

export interface AiRunRepository {
  /** UNIQUE(match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt) */
  append(record: AiRunRecord): Promise<AiRunRecord>;
  listByMatch(matchId: string): Promise<readonly AiRunRecord[]>;
}

export interface AuditLogRepository {
  /** 追記のみ。まとめて書く（設計 §13） */
  appendAll(records: readonly AuditLogRecord[]): Promise<void>;
  listByMatch(matchId: string): Promise<readonly AuditLogRecord[]>;
}

/** application 層が受け取る束。adapter の差し替え単位である */
export interface MatchRepositories {
  readonly matches: MatchRepository;
  readonly speeches: SpeechRepository;
  readonly cxTurns: CxTurnRepository;
  readonly evidenceUses: EvidenceUseRepository;
  readonly aiRuns: AiRunRepository;
  readonly auditLogs: AuditLogRepository;
}
