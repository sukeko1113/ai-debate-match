import { advanceMatch } from '@/application/advance-match';
import { buildMatchSnapshot } from '@/application/match-snapshot';
import { startMatchRequestSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/advance（設計 §14.1 / §14.3）。
 *
 * 1回で進むのは1ステップである。202 は返さない。ジョブキューも使わない。
 * P5 の時点では、AI生成を伴わない経路だけが進む（AIは P6）。
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
  const result = await advanceMatch(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
