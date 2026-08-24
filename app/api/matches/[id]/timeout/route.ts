import { humanTimeout } from '@/application/advance-match';
import { buildMatchSnapshot } from '@/application/match-snapshot';
import { getServerEnv } from '@/infrastructure/config/env';
import { startMatchRequestSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/timeout（設計 §11 HUMAN_TIMEOUT / §6.4）。
 *
 * **`CLOCK_MODE=manual` のときだけ受け付ける。** 設計 §14.3 の表には無い口である。
 * 準備スロットの `SKIP_PREP` と同じ位置づけで、manual のときに時計の代わりを務める。
 * realtime では 400 を返す。client に時間切れを宣言させないためである。
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
  const result = await humanTimeout(
    { ...deps, clockMode: getServerEnv().CLOCK_MODE },
    { matchId: id, expectedVersion: parsed.data.expectedVersion },
  );
  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
