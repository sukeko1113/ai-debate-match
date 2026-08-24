/**
 * Repository が返す拒否（設計 §13 / §13.1）。
 *
 * Memory と Postgres で同じ条件が同じように弾かれることを、同じテストで確かめる。
 * `constraint` には設計 §13.1 の索引名・制約名をそのまま入れる。
 * Postgres adapter を足したとき、DB が返す制約名と突き合わせられるようにするためである。
 */

export type RepositoryConstraint =
  /** UNIQUE(match_id, section_no)（設計 §13 speeches） */
  | 'speeches_match_section_uniq'
  /** CHECK section_no NOT IN (CXのセクション)（設計 §13 speeches） */
  | 'speeches_section_not_cx'
  /** UNIQUE(match_id, section_no, turn_index)（設計 §13 cx_turns） */
  | 'cx_turns_uniq'
  /** CHECK section_no IN (CXのセクション)（設計 §13 cx_turns） */
  | 'cx_turns_section_is_cx'
  /** CHECK ((speech_id IS NULL) <> (cx_turn_id IS NULL))（設計 §13.1） */
  | 'evidence_uses_one_source'
  /** 部分一意索引 WHERE speech_id IS NOT NULL（設計 §13.1） */
  | 'evidence_uses_speech_uniq'
  /** 部分一意索引 WHERE cx_turn_id IS NOT NULL（設計 §13.1） */
  | 'evidence_uses_cx_uniq'
  /** UNIQUE(match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt)（設計 §13.1） */
  | 'ai_runs_uniq'
  /** UNIQUE(match_id, argument_key)（設計 §13 arguments） */
  | 'arguments_match_key_uniq'
  /** PK(id)（設計 §13 evidence_cards） */
  | 'evidence_cards_pkey'
  /** PK(match_id) */
  | 'matches_pkey'
  /** FK: 参照先の行が無い */
  | 'foreign_key_violation';

export class RepositoryConflictError extends Error {
  readonly constraint: RepositoryConstraint;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    constraint: RepositoryConstraint,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'RepositoryConflictError';
    this.constraint = constraint;
    this.details = details;
  }
}

/** 楽観ロックの不一致（設計 §11 / §14.4 MATCH_VERSION_CONFLICT） */
export class MatchVersionConflictError extends Error {
  readonly matchId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(matchId: string, expectedVersion: number, actualVersion: number) {
    super(
      `version が一致しない（match=${matchId}, expected=${expectedVersion}, actual=${actualVersion}）。設計 §11`,
    );
    this.name = 'MatchVersionConflictError';
    this.matchId = matchId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** 設計 §14.4 MATCH_NOT_FOUND */
export class MatchNotFoundError extends Error {
  readonly matchId: string;

  constructor(matchId: string) {
    super(`match が存在しない（id=${matchId}）。設計 §14.4`);
    this.name = 'MatchNotFoundError';
    this.matchId = matchId;
  }
}
