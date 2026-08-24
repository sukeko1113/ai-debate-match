import { skipPrep } from '@/application/advance-match';
import { buildMatchSnapshot } from '@/application/match-snapshot';
import { startMatchRequestSchema } from '@/schemas/api';

import { aiServerDeps, errorResponse, readJsonBody, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/skip-prep（設計 §14.3 / §11 SKIP_PREP）。
 * manual・realtime のどちらでも、明示イベントで準備スロットを終えられる（設計 §6.4）。
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
  const result = await skipPrep(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
