import type { EvidenceCardRecord } from '@/domain/repositories';
import { createEvidenceCardRequestSchema, evidenceCardViewSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../../../_shared/http';

/**
 * POST /api/matches/:id/evidence-cards（設計 §14.3 / §15.6）。
 *
 * Evidence は手入力または seed のみで、AIには作らせない。
 * 登録は Setup の段階に限る（設計 §5.1）。試合が始まってからカードを増やすと、
 * 立論・反論の入力が同じ集合を見ていたという前提が崩れる。
 *
 * このAPIは matches の行を変えないため version を進めない。
 * ただし古い表示からの登録は拒否したいので、`expectedVersion` の一致は見る（設計 §11）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = createEvidenceCardRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return errorResponse('INVALID_HUMAN_OUTPUT', 'Evidence カードの入力が不正である。', {
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
  if (parsed.data.expectedVersion !== state.version) {
    return errorResponse('MATCH_VERSION_CONFLICT', '表示を更新して再試行してください。', {
      expectedVersion: parsed.data.expectedVersion,
      actualVersion: state.version,
    });
  }
  if (state.status !== 'draft' && state.status !== 'ready') {
    return errorResponse(
      'INVALID_TRANSITION',
      'Evidence カードの登録は試合開始前だけである（設計 §5.1）。',
      { status: state.status },
    );
  }

  const record: EvidenceCardRecord = {
    id: deps.newId('evidence_card'),
    matchId: id,
    side: parsed.data.side,
    title: parsed.data.title,
    sourceLabel: parsed.data.sourceLabel,
    publishedOn: parsed.data.publishedOn,
    quote: parsed.data.quote,
    // 手入力のカードは未検証として保存する（設計 §13 verification_status）
    verificationStatus: 'unverified',
    demoOnly: false,
  };
  await deps.repository.insertEvidenceCard(record);

  return successResponse(
    evidenceCardViewSchema.parse({
      id: record.id,
      side: record.side,
      title: record.title,
      sourceLabel: record.sourceLabel,
      publishedOn: record.publishedOn,
      quote: record.quote,
      verificationStatus: record.verificationStatus,
      demoOnly: record.demoOnly,
    }),
    201,
  );
}
