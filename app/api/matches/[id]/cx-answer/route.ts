import { buildMatchSnapshot } from '@/application/match-snapshot';
import { submitCxAnswer } from '@/application/run-cx-turn';
import { cxAnswerRequestSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/cx-answer（設計 §14.3 / §7）。
 *
 * 人間の回答を、いまの往復位置へ書く。位置を決めるのはサーバであり、
 * `cxTurnIndex` は照合のためだけに使う（CLAUDE.md 禁止事項）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = cxAnswerRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return errorResponse('INVALID_HUMAN_OUTPUT', '回答の入力が不正である（設計 §19）。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const deps = serverDeps();
  const result = await submitCxAnswer(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
    slotIndex: parsed.data.slotIndex,
    cxTurnIndex: parsed.data.cxTurnIndex,
    text: parsed.data.text,
    evidenceCardIds: parsed.data.evidenceCardIds,
  });

  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
