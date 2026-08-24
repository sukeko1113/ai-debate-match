import { describe, expect, it } from 'vitest';

import { loadServerEnv } from '@/infrastructure/config/env';

/** 設計 §22 の表と起動安全性 */
describe('環境変数', () => {
  it('未設定なら設計の既定値になる', () => {
    const env = loadServerEnv({});

    expect(env).toEqual({
      AI_PROVIDER: 'mock',
      MOCK_AI_FIXTURE: 'default',
      OPENAI_API_KEY: '',
      OPENAI_TEXT_MODEL: '',
      DATABASE_URL: '',
      PERSISTENCE_PROVIDER: 'memory',
      CLOCK_MODE: 'realtime',
      CX_EXCHANGES_PER_SECTION: 3,
      AI_RUN_TIMEOUT_MS: 30000,
      MAX_AI_RUNS_PER_MATCH: 40,
      MAX_AI_ATTEMPTS_PER_MATCH: 90,
      MAX_AI_RETRIES_PER_RUN: 2,
      MAX_MATCH_OUTPUT_TOKENS: 30000,
    });
  });

  it('数値は文字列から変換される', () => {
    const env = loadServerEnv({ MAX_AI_RUNS_PER_MATCH: '5' });
    expect(env.MAX_AI_RUNS_PER_MATCH).toBe(5);
  });

  it('未知の値を拒否する', () => {
    expect(() => loadServerEnv({ AI_PROVIDER: 'anthropic' })).toThrow(/環境変数が不正/);
    expect(() => loadServerEnv({ MAX_AI_RUNS_PER_MATCH: '0' })).toThrow(/環境変数が不正/);
  });

  it('CLOCK_MODE=manual はデプロイ環境では拒否される（設計 §22）', () => {
    expect(() => loadServerEnv({ CLOCK_MODE: 'manual', VERCEL: '1' })).toThrow(
      /デプロイ環境では使用できません/,
    );
  });

  it('CLOCK_MODE=manual は production build でも許可される（設計 §6.4）', () => {
    // E2E は production build に対して実行する。build かどうかで判定すると E10 が実行できない
    expect(loadServerEnv({ CLOCK_MODE: 'manual', NODE_ENV: 'production' }).CLOCK_MODE).toBe(
      'manual',
    );
  });

  it('CLOCK_MODE=manual は test では許可される', () => {
    expect(loadServerEnv({ CLOCK_MODE: 'manual', NODE_ENV: 'test' }).CLOCK_MODE).toBe('manual');
  });
});
