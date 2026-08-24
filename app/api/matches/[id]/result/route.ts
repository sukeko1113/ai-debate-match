import { findJudgeResult } from '@/application/judge-match';

import { errorResponse, serverDeps, successResponse } from '../../../_shared/http';

/**
 * GET /api/matches/:id/result（設計 §14.3 / §14.4）。
 * `judged` のときだけ 200。まだ判定していなければ 409 `RESULT_NOT_READY`。
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deps = serverDeps();

  const state = await deps.repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  const result = await findJudgeResult(deps.repository, id);
  if (result === null) {
    return errorResponse('RESULT_NOT_READY', '判定はまだ実行されていない（設計 §14.4）。', {
      status: state.status,
    });
  }

  return successResponse(result);
}
