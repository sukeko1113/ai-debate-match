import { buildMatchSnapshot } from '@/application/match-snapshot';

import { errorResponse, serverDeps, successResponse } from '../../_shared/http';

/**
 * GET /api/matches/:id（設計 §14.3）。
 * 再読込のたびにここへ戻る。進行位置は snapshot だけで復元できる（設計 §3.2）。
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { repository } = serverDeps();

  const state = await repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  return successResponse(await buildMatchSnapshot(repository, state));
}
