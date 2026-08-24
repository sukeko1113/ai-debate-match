import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

import { describeRepositoryContract } from '../support/repository-contract';

/**
 * Memory Repository（設計 §13 / §13.1 / §21.2）。
 *
 * 本文は `tests/support/repository-contract.ts` にあり、Postgres adapter も同じものを通る
 * （`tests/integration/postgres-repository.test.ts`）。ここは Memory の口だけを与える。
 */

describeRepositoryContract({
  name: 'Memory',
  matchId: 'match_repo_memory',
  createRepository: async () => createMemoryMatchRepository(),
  // Memory は match の rule set を引けるので、rule set に無いセクション番号も弾ける（P3 の判断）
  rejectsUnknownSectionNo: true,
});
