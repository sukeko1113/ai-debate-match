import 'server-only';

import type { MatchRepository } from '@/domain/repositories';
import { getServerEnv } from '@/infrastructure/config/env';

import { createMemoryMatchRepository } from './memory';
import { createPostgresMatchRepository } from './postgres';

/**
 * Repository の受け渡し（設計 §12.2 / §22 PERSISTENCE_PROVIDER）。
 *
 * Phase 1 の既定は Memory であり、**プロセス内で1つ**でなければならない。
 * Route Handler はリクエストごとに評価されるため、モジュールのローカル変数に置くと
 * 「直前に作った試合が次のリクエストで消える」ことが起こりうる。
 * dev の HMR でもモジュールが作り直されるため、`globalThis` に載せて同一性を保つ。
 *
 * Memory はプロセスを再起動すると消える。永続化が要るときは
 * `PERSISTENCE_PROVIDER=postgres` と `DATABASE_URL` を設定する（ADR 0001）。
 * 接続情報が無ければ**起動時に**落とす。黙って memory へ戻さない。
 */

const REPOSITORY_KEY = Symbol.for('ai-debate-match.match-repository');

type RepositoryHolder = { [REPOSITORY_KEY]?: MatchRepository };

function holder(): RepositoryHolder {
  return globalThis as unknown as RepositoryHolder;
}

function createRepository(): MatchRepository {
  const env = getServerEnv();
  if (env.PERSISTENCE_PROVIDER !== 'postgres') return createMemoryMatchRepository();

  if (env.DATABASE_URL === '') {
    // 接続文字列の値はメッセージに出さない（設計 §19）
    throw new Error(
      'PERSISTENCE_PROVIDER=postgres には DATABASE_URL が必要である（ADR 0001）。' +
        'memory で動かすなら PERSISTENCE_PROVIDER=memory にする。',
    );
  }
  return createPostgresMatchRepository(env.DATABASE_URL);
}

export function getMatchRepository(): MatchRepository {
  const store = holder();
  store[REPOSITORY_KEY] ??= createRepository();
  return store[REPOSITORY_KEY];
}

/** test 用。プロセス内の実体を捨てる */
export function resetMatchRepository(): void {
  delete holder()[REPOSITORY_KEY];
}
