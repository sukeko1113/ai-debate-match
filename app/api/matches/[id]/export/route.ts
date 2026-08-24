import { exportMatch } from '@/application/export-match';

import { errorResponse, serverDeps } from '../../../_shared/http';

/**
 * GET /api/matches/:id/export（設計 §14.3）。
 *
 * 試合の記録一式を `application/json` で返す。鍵と prompt 全文は含めない（設計 §19）。
 * 付録D により『AIによる暫定評価』を JSON にも入れる。
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deps = serverDeps();

  const state = await deps.repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  const body = await exportMatch(deps.repository, state);
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="match-${id}.json"`,
    },
  });
}
