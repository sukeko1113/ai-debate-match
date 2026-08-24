import { buildMatchSnapshot } from '@/application/match-snapshot';
import { argumentInventoryOf } from '@/domain/arguments';
import { reduce } from '@/domain/match';
import { startMatchRequestSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/start（設計 §14.3 / §11 START）。
 * 進行位置はサーバが決める。client は expectedVersion だけを送る。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = startMatchRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return errorResponse('INVALID_HUMAN_OUTPUT', 'expectedVersion が必要である（設計 §11）。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const deps = serverDeps();
  const state = await deps.repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  // 論点在庫は保存済みの arguments から作る。client からは受け取らない（設計 §10）
  const args = argumentInventoryOf(await deps.repository.listArguments(id));
  const transition = reduce(state, {
    type: 'START',
    expectedVersion: parsed.data.expectedVersion,
    args,
  });
  if (!transition.ok) {
    return errorResponse(
      transition.error.code,
      transition.error.message,
      transition.error.details,
    );
  }

  await deps.repository.updateMatch(transition.state, state.version);
  await deps.repository.appendAuditLogs(transition.auditEvents, deps.now());

  return successResponse(await buildMatchSnapshot(deps.repository, transition.state));
}
