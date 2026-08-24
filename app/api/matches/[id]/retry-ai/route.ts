import { buildMatchSnapshot } from '@/application/match-snapshot';
import { retryCxTurn } from '@/application/run-cx-turn';
import { retryAiSlot } from '@/application/run-slot';
import { currentSlot } from '@/domain/match';
import { startMatchRequestSchema } from '@/schemas/api';

import { aiServerDeps, errorResponse, readJsonBody, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/retry-ai（設計 §14.3 / §11 RETRY_AI）。
 *
 * `paused` から**同じ slot・同じ cx_turn_cursor**で再実行する。位置は触らない。
 * attempt は保存済みの ai_runs から続き番号になる（設計 §13.1）。
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
  const state = await deps.repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  // 質疑は往復が単位なので、再実行の入口も分ける（設計 §7）
  const retry = currentSlot(state)?.kind === 'cx' ? retryCxTurn : retryAiSlot;
  const result = await retry(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
  });
  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
