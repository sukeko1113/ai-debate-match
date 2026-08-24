import 'server-only';

import { getServerEnv } from '@/infrastructure/config/env';
import { loadMockAiFixture } from '@/infrastructure/content';

import { createMockDebateProvider } from './mock-provider';
import type { DebateAiProvider } from './provider';

/**
 * Provider の受け渡し（設計 §15.5 / §22 AI_PROVIDER）。
 *
 * 既定は Mock である。`OPENAI_API_KEY` があっても `AI_PROVIDER=openai` でなければ
 * 外部呼び出しは起きない（設計 §22 起動安全性）。
 *
 * Mock は (role, sectionNo) ごとの呼び出し回数で fixture を進める（設計 §15.7）。
 * その並びは**リクエストをまたいで続く**必要がある。`paused` からの `retry-ai` は
 * 別のリクエストであり、そこで並びが先頭へ戻ると「再試行で直る」筋書きが再現できない。
 * よって Repository と同じく `globalThis` に載せてプロセス内で1つに保つ。
 */

const PROVIDER_KEY = Symbol.for('ai-debate-match.debate-ai-provider');

type ProviderHolder = { [PROVIDER_KEY]?: DebateAiProvider };

function holder(): ProviderHolder {
  return globalThis as unknown as ProviderHolder;
}

export function getDebateAiProvider(): DebateAiProvider {
  const env = getServerEnv();

  if (env.AI_PROVIDER === 'openai' && env.OPENAI_TEXT_MODEL !== '') {
    throw new Error(
      'OpenAI Text Provider は Phase 1 の後続PRで実装する（設計 §20 P10）。AI_PROVIDER=mock を使うこと。',
    );
  }
  // OPENAI_TEXT_MODEL が未設定なら Mock へ戻す（設計 §15.5 実Provider の行）

  const store = holder();
  store[PROVIDER_KEY] ??= createMockDebateProvider(loadMockAiFixture());
  return store[PROVIDER_KEY];
}

/** test 用。fixture を差し替えるときにも使う */
export function setDebateAiProvider(provider: DebateAiProvider): void {
  holder()[PROVIDER_KEY] = provider;
}

export function resetDebateAiProvider(): void {
  delete holder()[PROVIDER_KEY];
}
