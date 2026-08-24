import { judgeMatch } from '@/application/judge-match';
import { buildMatchSnapshot } from '@/application/match-snapshot';
import { startMatchRequestSchema } from '@/schemas/api';

import { aiServerDeps, errorResponse, readJsonBody, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/judge（設計 §14.3 / §11 JUDGE）。
 *
 * **同期で実行する。** 202 を返さず、ジョブキューも使わない（設計 §14.1）。
 * 同じ rubric_version では二度採点しない（設計 §21.2）。
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

  const deps = aiServerDeps();
  const judged = await judgeMatch(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (!judged.ok) {
    return errorResponse(judged.code, judged.message, judged.details);
  }

  return successResponse({
    snapshot: await buildMatchSnapshot(deps.repository, judged.state),
    result: judged.result,
  });
}
