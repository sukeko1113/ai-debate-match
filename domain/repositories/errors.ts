/**
 * Repository が返す失敗（設計 §13 / §13.1）。
 *
 * Memory と Postgres の両adapterが同じ失敗を同じ形で返すための共通語彙である。
 * Postgres adapter は SQLSTATE をこの形へ写す。`constraint` には設計 §13.1 の
 * 索引名をそのまま入れ、どの一意性で弾かれたかを両adapterで一致させる。
 */
export type RepositoryErrorCode =
  | 'UNIQUE_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT';

export class RepositoryError extends Error {
  override readonly name = 'RepositoryError';
  readonly code: RepositoryErrorCode;
  /** 違反した制約・索引の名前（設計 §13.1） */
  readonly constraint: string | null;

  constructor(code: RepositoryErrorCode, message: string, constraint: string | null = null) {
    super(message);
    this.code = code;
    this.constraint = constraint;
  }
}

export function isRepositoryError(error: unknown): error is RepositoryError {
  return error instanceof RepositoryError;
}
