import 'server-only';

import { z } from 'zod';

/**
 * サーバ専用の環境変数（設計 §22）。
 * このモジュールは server-only。client bundle から import しない。
 * client 公開用の接頭辞つき環境変数は定義しない。理由と規約は .env.example の冒頭に書いてある。
 */

/** process.env と同じ形。test からは任意の record を渡せる */
export type EnvSource = Record<string, string | undefined>;

const isProductionRuntime = (source: EnvSource): boolean => source.NODE_ENV === 'production';

const intFromString = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  AI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().default(''),
  PERSISTENCE_PROVIDER: z.enum(['memory', 'postgres']).default('memory'),
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
 * production build では CLOCK_MODE=manual を許可しない（設計 §22 起動安全性）。
 */
export function loadServerEnv(source: EnvSource = process.env): ServerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`環境変数が不正です: ${z.prettifyError(parsed.error)}`);
  }

  const env = parsed.data;
  if (env.CLOCK_MODE === 'manual' && isProductionRuntime(source)) {
    throw new Error('CLOCK_MODE=manual は production では使用できません（設計 §22）。');
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
