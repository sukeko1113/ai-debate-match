import type { AuditEvent, MatchState } from '../match';

import type {
  AiRunRecord,
  AuditLogRecord,
  CxTurnRecord,
  EvidenceUseRecord,
  SpeechRecord,
} from './records';

/**
 * 永続化の interface（設計 §12.1 / §12.2 / §13）。
 *
 * interface は domain 側に置き、実装は infrastructure に置く。
 * domain は infrastructure を import しない。
 *
 * Phase 1 の既定は Memory 実装であり、Postgres 実装は任意である（設計 §13.1）。
 * 両者が同じテストを通ることを前提に、一意性の判定条件をこの契約の一部として扱う。
 * 違反は `RepositoryConflictError` で、設計 §13.1 の索引名を持って投げる。
 *
 * すべて Promise を返す。Memory 実装はプロセス内で完結するが、
 * Postgres 実装が同じ呼び出し側から使えるように非同期で揃える。
 */
export interface MatchRepository {
  /** 新しい試合を作る。同じ id が既にあれば衝突 */
  createMatch(state: MatchState): Promise<void>;

  /** 見つからなければ null。呼び出し側が MATCH_NOT_FOUND に写す */
  findMatch(matchId: string): Promise<MatchState | null>;

  /**
   * 楽観ロック付きの更新（設計 §11）。
   * 保存されている version が `expectedVersion` と違えば `MatchVersionConflictError`。
   * reducer が version を +1 した後の state を渡す。
   */
  updateMatch(state: MatchState, expectedVersion: number): Promise<void>;

  /** 監査ログの追記（設計 §13）。時刻はここで付ける */
  appendAuditLogs(events: readonly AuditEvent[], createdAt: string): Promise<void>;
  listAuditLogs(matchId: string): Promise<readonly AuditLogRecord[]>;

  /** UNIQUE(match_id, section_no)。CXセクションには書けない（設計 §13） */
  insertSpeech(record: SpeechRecord): Promise<void>;
  listSpeeches(matchId: string): Promise<readonly SpeechRecord[]>;

  /** UNIQUE(match_id, section_no, turn_index)。CXセクションにだけ書ける（設計 §13） */
  insertCxTurn(record: CxTurnRecord): Promise<void>;
  /** 同一 turn_index の行へ回答を書く（設計 §7） */
  updateCxTurnAnswer(input: {
    matchId: string;
    sectionNo: number;
    turnIndex: number;
    answerText: string;
    truncated?: boolean;
  }): Promise<void>;
  listCxTurns(matchId: string): Promise<readonly CxTurnRecord[]>;

  /** 出典は speech か cx_turn のどちらか一方。部分一意索引で重複を弾く（設計 §13.1） */
  insertEvidenceUse(record: EvidenceUseRecord): Promise<void>;
  listEvidenceUses(matchId: string): Promise<readonly EvidenceUseRecord[]>;

  /** (match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt) が一意（設計 §13.1） */
  insertAiRun(record: AiRunRecord): Promise<void>;
  listAiRuns(matchId: string): Promise<readonly AiRunRecord[]>;
}
