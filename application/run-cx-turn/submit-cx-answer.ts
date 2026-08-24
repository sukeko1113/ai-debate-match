import { commitTransition, failure, type GenerationFailure } from '@/application/run-slot';
import { SUPPORT_USE_TYPE } from '@/domain/arguments';
import { currentCxTurnIndex } from '@/domain/cx';
import { currentSlot, reduce, type MatchState } from '@/domain/match';
import type { EvidenceUseRecord, MatchRepository } from '@/domain/repositories';
import { seatSide } from '@/schemas/common';

/**
 * 人間のCX回答（設計 §14.3 cx-answer / §7）。
 *
 * 進める位置を決めるのはサーバである。`cxTurnIndex` は照合のためだけに受け取り、
 * 現在の cursor と違えば拒否する（CLAUDE.md 禁止事項）。
 *
 * **逆質問の検査は人間の回答には行わない。** 設計 §15.5 はAI出力の失敗時動作の表であり、
 * 人間の入力を拒否する根拠にはならない。人間側の制約は字数と Evidence だけである（設計 §19）。
 */

export type SubmitCxAnswerDeps = {
  readonly repository: MatchRepository;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

export type SubmitCxAnswerParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
  readonly slotIndex: number;
  readonly cxTurnIndex: number;
  readonly text: string;
  readonly evidenceCardIds: readonly string[];
};

export type SubmitCxAnswerResult =
  | { readonly ok: true; readonly state: MatchState }
  | GenerationFailure;

export async function submitCxAnswer(
  deps: SubmitCxAnswerDeps,
  params: SubmitCxAnswerParams,
): Promise<SubmitCxAnswerResult> {
  const { repository } = deps;

  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const slot = currentSlot(state);
  if (slot === null || slot.kind !== 'cx' || slot.respondentSeat === null) {
    return failure('INVALID_TRANSITION', '質疑のスロットではない（設計 §7）。', {
      slotIndex: state.currentSlotIndex,
      slotKind: slot?.kind ?? null,
    });
  }
  if (params.slotIndex !== state.currentSlotIndex) {
    return failure('INVALID_TRANSITION', '現在スロットへの回答ではない（設計 §6.3）。', {
      slotIndex: params.slotIndex,
      currentSlotIndex: state.currentSlotIndex,
    });
  }
  if (state.cx === null || state.cx.phase !== 'answer') {
    return failure('SLOT_NOT_READY', 'いまは回答の番ではない（設計 §7）。', {
      cxPhase: state.cx?.phase ?? null,
    });
  }
  if (params.cxTurnIndex !== currentCxTurnIndex(state.cx)) {
    return failure('SLOT_NOT_READY', '往復位置が現在の cursor と違う（設計 §7）。', {
      cxTurnIndex: params.cxTurnIndex,
      cursor: currentCxTurnIndex(state.cx),
    });
  }

  const sectionNo = slot.sectionNo;
  if (sectionNo === null) {
    return failure('INVALID_TRANSITION', '競技スロットは sectionNo を持つ（設計 §6.1）。', {
      slotIndex: slot.index,
    });
  }

  // 質問が先に確定していること（設計 §7 質問の確定 → 回答の確定）
  const turns = await repository.listCxTurns(params.matchId);
  const turn = turns.find(
    (entry) => entry.sectionNo === sectionNo && entry.turnIndex === params.cxTurnIndex,
  );
  if (turn === undefined) {
    return failure('SLOT_NOT_READY', '回答する質問がまだ無い（設計 §7）。', {
      sectionNo,
      cxTurnIndex: params.cxTurnIndex,
    });
  }
  if (turn.answerText !== null) {
    return failure('SLOT_NOT_READY', 'この往復には既に回答がある（設計 §7）。', {
      sectionNo,
      cxTurnIndex: params.cxTurnIndex,
    });
  }

  // Evidence は match の集合の部分集合で、回答者の陣営と一致すること（設計 §8.2 と同じ規則）
  const answeringSide = seatSide(slot.respondentSeat);
  const cards = await repository.listEvidenceCards(params.matchId);
  const issues: string[] = [];
  const seen = new Set<string>();
  params.evidenceCardIds.forEach((cardId, position) => {
    const card = cards.find((entry) => entry.id === cardId);
    if (card === undefined) {
      issues.push(`evidenceCardIds.${position}: この match に存在しない Evidence である: ${cardId}`);
      return;
    }
    if (card.side !== answeringSide) {
      issues.push(
        `evidenceCardIds.${position}: Evidence の side が回答者と一致しない（カード=${card.side}, 回答=${answeringSide}）`,
      );
    }
    if (seen.has(cardId)) {
      issues.push(`evidenceCardIds.${position}: 同じ Evidence を2回使えない（設計 §13.1）`);
    }
    seen.add(cardId);
  });
  if (issues.length > 0) {
    return failure('INVALID_HUMAN_OUTPUT', '回答の入力が競技制約に合わない（設計 §8.2）。', {
      issues,
    });
  }

  // 状態機械を先に引く。通らなければ1行も書かない（P4 と同じ順序）
  const dryRun = reduce(state, { type: 'HUMAN_SUBMIT', expectedVersion: params.expectedVersion });
  if (!dryRun.ok) {
    return failure(dryRun.error.code, dryRun.error.message, dryRun.error.details);
  }

  await repository.updateCxTurnAnswer({
    matchId: params.matchId,
    sectionNo,
    turnIndex: params.cxTurnIndex,
    answerText: params.text,
  });

  for (const cardId of params.evidenceCardIds) {
    const record: EvidenceUseRecord = {
      id: deps.newId('evidence_use'),
      matchId: params.matchId,
      // CXの使用は cx_turn 側に書く（設計 §13.1）
      speechId: null,
      cxTurnId: turn.id,
      evidenceCardId: cardId,
      argumentKey: turn.targetArgumentKey ?? '',
      useType: SUPPORT_USE_TYPE,
    };
    await repository.insertEvidenceUse(record);
  }

  return commitTransition(deps, state, {
    type: 'HUMAN_SUBMIT',
    expectedVersion: params.expectedVersion,
  });
}
