import { buildMatchSnapshot } from '@/application/match-snapshot';
import { submitConstructive } from '@/application/submit-constructive';
import { constructiveLimits, slotSide } from '@/domain/arguments';
import { currentSlot } from '@/domain/match';
import { buildConstructiveRequestSchema } from '@/schemas/human-input';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/constructive（設計 §14.3 / §8）。
 *
 * 採番も本文の組み立てもサーバが行う。`argumentKey` や `kind`、`currentSlotIndex` を
 * 受け取る口はここに無い。未知キーは schema が拒否する（CLAUDE.md 禁止事項）。
 *
 * 件数の上限は側によって変わるため、現在スロットから side を決めてから本文を検証する。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deps = serverDeps();

  const state = await deps.repository.findMatch(id);
  if (state === null) {
    return errorResponse('MATCH_NOT_FOUND', `match が見つからない（id=${id}）。`, { matchId: id });
  }

  const slot = currentSlot(state);
  if (slot === null || slot.kind !== 'constructive') {
    return errorResponse(
      'INVALID_TRANSITION',
      '立論を提出できるのは Constructive スロットだけである（設計 §6.3）。',
      { slotIndex: state.currentSlotIndex, slotKind: slot?.kind ?? null },
    );
  }

  const side = slotSide(slot);
  const parsed = buildConstructiveRequestSchema(constructiveLimits(state.ruleSet, side)).safeParse(
    await readJsonBody(request),
  );
  if (!parsed.success) {
    return errorResponse('INVALID_HUMAN_OUTPUT', '立論の入力が競技制約に合わない（設計 §8.1）。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const result = await submitConstructive(deps, {
    matchId: id,
    expectedVersion: parsed.data.expectedVersion,
    slotIndex: parsed.data.slotIndex,
    source: 'human',
    input: { plan: parsed.data.plan, arguments: parsed.data.arguments },
  });

  if (!result.ok) {
    return errorResponse(result.code, result.message, result.details);
  }

  return successResponse(await buildMatchSnapshot(deps.repository, result.state));
}
