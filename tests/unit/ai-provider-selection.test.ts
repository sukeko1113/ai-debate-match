import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDebateAiProvider, resetDebateAiProvider } from '@/infrastructure/ai';
import { resetServerEnvCache } from '@/infrastructure/config/env';

/**
 * 起動安全性（設計 §22 / §15.5）。
 *
 * > `OPENAI_API_KEY` が存在しても `AI_PROVIDER=openai` でなければ外部呼出ししない。
 *
 * ここでは**Provider を作るところまで**を見る。外部は1回も呼ばない。
 * 実際の HTTP は `tests/unit/openai-provider.test.ts` が fetch を差し替えて見ている。
 */

const KEYS = ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL'] as const;

let saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  resetServerEnvCache();
  resetDebateAiProvider();
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  resetServerEnvCache();
  resetDebateAiProvider();
});

describe('Provider の選択（設計 §22）', () => {
  it('既定は Mock である', () => {
    setEnv({ AI_PROVIDER: 'mock' });
    expect(getDebateAiProvider().name).toBe('mock');
  });

  it('鍵とモデルがあっても AI_PROVIDER=mock なら Mock のままである', () => {
    setEnv({
      AI_PROVIDER: 'mock',
      OPENAI_API_KEY: 'sk-test-DO-NOT-USE',
      OPENAI_TEXT_MODEL: 'test-model',
    });
    expect(getDebateAiProvider().name).toBe('mock');
  });

  it('AI_PROVIDER=openai でも OPENAI_TEXT_MODEL が無ければ Mock へ戻す（設計 §15.5）', () => {
    setEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-DO-NOT-USE' });
    expect(getDebateAiProvider().name).toBe('mock');
  });

  it('モデルはあるのに鍵が無ければ、起動時に分かる形で失敗する', () => {
    setEnv({ AI_PROVIDER: 'openai', OPENAI_TEXT_MODEL: 'test-model' });
    expect(() => getDebateAiProvider()).toThrow(/OPENAI_API_KEY/);
  });

  it('失敗のメッセージに鍵の値を出さない（設計 §19）', () => {
    setEnv({ AI_PROVIDER: 'openai', OPENAI_TEXT_MODEL: 'test-model', OPENAI_API_KEY: '' });
    try {
      getDebateAiProvider();
      expect.unreachable('鍵が無いので失敗するはず');
    } catch (error) {
      expect(String(error)).not.toContain('sk-');
    }
  });

  it('鍵とモデルが揃えば OpenAI Provider になる', () => {
    setEnv({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-DO-NOT-USE',
      OPENAI_TEXT_MODEL: 'test-model',
    });
    const provider = getDebateAiProvider();
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('test-model');
  });

  it('プロセス内で1つに保つ。試合の途中で経路が変わらない', () => {
    setEnv({ AI_PROVIDER: 'mock' });
    const first = getDebateAiProvider();
    expect(getDebateAiProvider()).toBe(first);
  });
});
