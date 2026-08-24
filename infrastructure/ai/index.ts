import 'server-only';

import { getServerEnv } from '@/infrastructure/config/env';
import { loadMockAiFixture } from '@/infrastructure/content';

import { createMockDebateProvider } from './mock-provider';
import { createOpenAiDebateProvider } from './openai-provider';
import type { DebateAiProvider } from './provider';

/**
 * Provider の受け渡し（設計 §15.5 / §22 AI_PROVIDER）。
 *
 * 既定は Mock である。`OPENAI_API_KEY` があっても `AI_PROVIDER=openai` でなければ
 * 外部呼び出しは起きない（設計 §22 起動安全性）。
 *
 * | AI_PROVIDER | OPENAI_TEXT_MODEL | OPENAI_API_KEY | 動作 |
 * | --- | --- | --- | --- |
 * | mock | 何でも | 何でも | Mock。外部呼出なし |
 * | openai | 未設定 | 何でも | Mock へ戻す（設計 §15.5 実Provider の行） |
 * | openai | 設定 | 未設定 | 起動時に投げる。外部は呼ばない |
 * | openai | 設定 | 設定 | OpenAI Provider |
 *
 * 判定は**プロセスで1回**だけ行う。試合の途中で経路が変わらないよう、
 * Repository と同じく `globalThis` に載せて1つに保つ。Mock の fixture の並びが
 * リクエストをまたいで続くこと（設計 §15.7）も、この1つ持ちに依っている。
 */

const PROVIDER_KEY = Symbol.for('ai-debate-match.debate-ai-provider');

type ProviderHolder = { [PROVIDER_KEY]?: DebateAiProvider };

function holder(): ProviderHolder {
  return globalThis as unknown as ProviderHolder;
}

function createProvider(): DebateAiProvider {
  const env = getServerEnv();

  if (env.AI_PROVIDER !== 'openai' || env.OPENAI_TEXT_MODEL === '') {
    // OPENAI_TEXT_MODEL が未設定なら Mock へ戻す（設計 §15.5）
    return createMockDebateProvider(loadMockAiFixture(env.MOCK_AI_FIXTURE));
  }

  if (env.OPENAI_API_KEY === '') {
    // 鍵の値はメッセージに出さない（設計 §19）
    throw new Error(
      'AI_PROVIDER=openai かつ OPENAI_TEXT_MODEL 設定ずみだが OPENAI_API_KEY が無い。' +
        'Mock で動かすなら AI_PROVIDER=mock にする（設計 §22）。',
    );
  }

  return createOpenAiDebateProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_TEXT_MODEL,
  });
}

export function getDebateAiProvider(): DebateAiProvider {
  const store = holder();
  store[PROVIDER_KEY] ??= createProvider();
  return store[PROVIDER_KEY];
}

/** test 用。fixture を差し替えるときにも使う */
export function setDebateAiProvider(provider: DebateAiProvider): void {
  holder()[PROVIDER_KEY] = provider;
}

export function resetDebateAiProvider(): void {
  delete holder()[PROVIDER_KEY];
}
