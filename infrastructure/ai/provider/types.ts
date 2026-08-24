import type { ZodType } from 'zod';

/**
 * AI Provider の契約（設計 §15.1）。
 *
 * interface は infrastructure 側に置く。domain はここを import しない（設計 §12.1）。
 * 呼ぶのは application 層だけであり、client から直接は呼ばない。
 *
 * **schema は argument key の enum を注入済みで渡す。** 未知の key は Provider を
 * 通った時点で落ちる。実装（Mock / OpenAI）は schema の中身を知らなくてよい。
 */

/** 設計 §15.1 role。P6 で実装するのは constructive / attack / defense / summary */
export type AiRole =
  | 'constructive'
  | 'cx_question'
  | 'cx_answer'
  | 'attack'
  | 'defense'
  | 'summary'
  | 'judge';

/** 設計 §13 ai_runs.usage_json / §17 の集計に使う */
export type UsageSnapshot = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type AiGenerateRequest<T> = {
  readonly role: AiRole;
  /** argument key の enum を注入済みの schema（設計 §15.1） */
  readonly schema: ZodType<T>;
  readonly systemPrompt: string;
  readonly input: unknown;
  readonly maxOutputTokens: number;
  /** 既定 30000（設計 §22 AI_RUN_TIMEOUT_MS） */
  readonly timeoutMs: number;
  /** match + slot + cxTurn + role + attempt（設計 §13.1 の一意キーと同じ粒度） */
  readonly idempotencyKey: string;
};

export type AiGenerateResult<T> = {
  readonly parsed: T;
  readonly raw: string;
  readonly usage: UsageSnapshot;
};

export interface DebateAiProvider {
  /** ai_runs.provider に入れる名前 */
  readonly name: string;
  /** ai_runs.model に入れる名前 */
  readonly model: string;
  /** ai_runs.prompt_version に入れる版 */
  readonly promptVersion: string;
  generate<T>(request: AiGenerateRequest<T>): Promise<AiGenerateResult<T>>;
}

/**
 * 生成が使える出力にならなかった（設計 §15.5）。
 *
 * `kind` で再試行の仕方を分ける。
 * - `schema`: JSON parse / Zod 失敗。修復指示を付けて最大2回再生成
 * - `timeout`: 自動再試行は1回まで
 * - `unavailable`: provider 障害。503 に写す
 */
export type AiFailureKind = 'schema' | 'timeout' | 'unavailable';

export class AiProviderError extends Error {
  override readonly name = 'AiProviderError';
  readonly kind: AiFailureKind;
  /** schema 失敗のときの違反一覧。再生成の入力になる */
  readonly issues: readonly string[];
  /** 受け取った生の出力。ai_runs に残す */
  readonly raw: string | null;

  constructor(
    kind: AiFailureKind,
    message: string,
    options: { issues?: readonly string[]; raw?: string | null } = {},
  ) {
    super(message);
    this.kind = kind;
    this.issues = options.issues ?? [];
    this.raw = options.raw ?? null;
  }
}

export function isAiProviderError(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError;
}
