import 'server-only';

import { z } from 'zod';

/**
 * サーバ専用の環境変数（設計 §22）。
 * このモジュールは server-only。client bundle から import しない。
 * client 公開用の接頭辞つき環境変数は定義しない。理由と規約は .env.example の冒頭に書いてある。
 */

/** process.env と同じ形。test からは任意の record を渡せる */
export type EnvSource = Record<string, string | undefined>;

/**
 * デプロイ環境かどうか（設計 §6.4 / §22）。
 *
 * **`NODE_ENV=production` では判定しない。** E2E は production build に対して実行するため、
 * build かどうかで判定すると E10（manual で prep が自動進行しないこと）を確かめられない。
 * 判定はデプロイ環境変数で行う。
 */
const DEPLOYMENT_ENV_KEYS = ['VERCEL', 'VERCEL_ENV', 'RENDER', 'FLY_APP_NAME'] as const;

const isDeployedRuntime = (source: EnvSource): boolean =>
  DEPLOYMENT_ENV_KEYS.some((key) => (source[key] ?? '') !== '');

const intFromString = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  AI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  /**
   * Mock が読む fixture のファイル名（設計 §15.7）。既定は `default`。
   * 設計 §22 の表には無い。論点0件の筋書き（設計 §10）は通常系と同じ位置で
   * 別の出力を要求するため、fixture を差し替える口が要る。
   */
  MOCK_AI_FIXTURE: z.string().regex(/^[A-Za-z0-9_-]+$/).default('default'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().default(''),
  PERSISTENCE_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
  /**
   * Postgres の接続文字列（ADR 0001）。設計 §22 の表には無い。
   * `PERSISTENCE_PROVIDER=postgres` のときだけ使う。名前は Supabase と各種ホストの慣習に合わせる。
   * **値はログにもレスポンスにも出さない**（設計 §19）。
   */
  DATABASE_URL: z.string().default(''),
  CLOCK_MODE: z.enum(['realtime', 'manual']).default('realtime'),
  CX_EXCHANGES_PER_SECTION: intFromString(3),
  AI_RUN_TIMEOUT_MS: intFromString(30000),
  MAX_AI_RUNS_PER_MATCH: intFromString(40),
  MAX_AI_ATTEMPTS_PER_MATCH: intFromString(90),
  MAX_AI_RETRIES_PER_RUN: intFromString(2),
  MAX_MATCH_OUTPUT_TOKENS: intFromString(30000),
});

export type ServerEnv = z.infer<typeof envSchema>;

/**
 * 環境変数を読み、既定値を埋めて返す。
 * デプロイ環境では CLOCK_MODE=manual を許可しない（設計 §22 起動安全性 / §6.4）。
 */
export function loadServerEnv(source: EnvSource = process.env): ServerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`環境変数が不正です: ${z.prettifyError(parsed.error)}`);
  }

  const env = parsed.data;
  if (env.CLOCK_MODE === 'manual' && isDeployedRuntime(source)) {
    throw new Error('CLOCK_MODE=manual はデプロイ環境では使用できません（設計 §22）。');
  }

  return env;
}

let cached: ServerEnv | undefined;

/** プロセス内で1度だけ解決する読み取り口 */
export function getServerEnv(): ServerEnv {
  cached ??= loadServerEnv();
  return cached;
}

/** test 用。キャッシュを捨てる */
export function resetServerEnvCache(): void {
  cached = undefined;
}
