import 'server-only';

import type { MatchRepository } from '@/domain/repositories';
import { getServerEnv } from '@/infrastructure/config/env';

import { createMemoryMatchRepository } from './memory';

/**
 * Repository の受け渡し（設計 §12.2 / §22 PERSISTENCE_PROVIDER）。
 *
 * Phase 1 の既定は Memory であり、**プロセス内で1つ**でなければならない。
 * Route Handler はリクエストごとに評価されるため、モジュールのローカル変数に置くと
 * 「直前に作った試合が次のリクエストで消える」ことが起こりうる。
 * dev の HMR でもモジュールが作り直されるため、`globalThis` に載せて同一性を保つ。
 *
 * Memory はプロセスを再起動すると消える。永続化が要る場合は Postgres adapter を足す
 * （ADR 0001）。P5 の時点では未実装であり、選択されたら明示的に落とす。
 */

const REPOSITORY_KEY = Symbol.for('ai-debate-match.match-repository');

type RepositoryHolder = { [REPOSITORY_KEY]?: MatchRepository };

function holder(): RepositoryHolder {
  return globalThis as unknown as RepositoryHolder;
}

export function getMatchRepository(): MatchRepository {
  const env = getServerEnv();
  if (env.PERSISTENCE_PROVIDER === 'postgres') {
    throw new Error(
      'PERSISTENCE_PROVIDER=postgres は Phase 1 では未実装である（ADR 0001）。memory を使うこと。',
    );
  }

  const store = holder();
  store[REPOSITORY_KEY] ??= createMemoryMatchRepository();
  return store[REPOSITORY_KEY];
}

/** test 用。プロセス内の実体を捨てる */
export function resetMatchRepository(): void {
  delete holder()[REPOSITORY_KEY];
}
