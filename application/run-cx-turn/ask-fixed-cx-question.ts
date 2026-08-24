import { failure, type GenerationFailure } from '@/application/run-slot';
import { argumentInventoryOf } from '@/domain/arguments';
import { currentCxTurnIndex } from '@/domain/cx';
import { noArgumentCxQuestionAt } from '@/domain/fallback';
import { currentSlot, reduce, type MatchState } from '@/domain/match';
import type { CxTurnRecord, MatchRepository } from '@/domain/repositories';

/**
 * 論点0件のCXで、固定質問を1件出す（設計 §10 / §10.1）。
 *
 * **AIを呼ばない。** `ai_runs` に行は増えない。質問文は論題ごとに
 * `motions.noArgumentCxQuestions` にあり、往復位置の順に提示する（設計 §10.1）。
 *
 * `target_argument_key` は null で保存する。参照できる論点が存在しないためである
 * （設計 §10 の「targetArgumentKey=null を許可」）。
 *
 * 回答は通常どおりである。回答席が human なら人間が答え、ai なら AI が答える。
 * ここで進めるのは質問1件だけである（設計 §14.1）。
 */

export type AskFixedCxQuestionDeps = {
  readonly repository: MatchRepository;
  /** 論題の固定質問（設計 §10.1）。AIには作らせない */
  readonly noArgumentCxQuestionsFor: (motionCode: string) => readonly string[];
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

export type AskFixedCxQuestionParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type AskFixedCxQuestionResult =
  | { readonly ok: true; readonly state: MatchState }
  | GenerationFailure;

export async function askFixedCxQuestion(
  deps: AskFixedCxQuestionDeps,
  params: AskFixedCxQuestionParams,
): Promise<AskFixedCxQuestionResult> {
  const { repository } = deps;
  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const slot = currentSlot(state);
  if (
    slot === null ||
    slot.kind !== 'cx' ||
    slot.sectionNo === null ||
    slot.actorSeat === null ||
    slot.respondentSeat === null
  ) {
    return failure('INVALID_TRANSITION', '固定質問を出せるスロットではない（設計 §10.1）。', {
      slotIndex: state.currentSlotIndex,
      slotKind: slot?.kind ?? null,
    });
  }
  if (state.cx === null || state.cx.phase !== 'question') {
    return failure('INVALID_TRANSITION', 'いまは質問の番ではない（設計 §7）。', {
      slotIndex: slot.index,
      cxPhase: state.cx?.phase ?? null,
    });
  }

  const turnIndex = currentCxTurnIndex(state.cx);
  const questions = deps.noArgumentCxQuestionsFor(state.motion.code);
  const questionText = noArgumentCxQuestionAt(questions, turnIndex);
  if (questionText === null) {
    // AIに作らせない（設計 §10.1）。足りない事実をそのまま報告して止める
    return failure(
      'INVALID_TRANSITION',
      `論題の固定質問が往復数に足りない（設計 §10.1）。motion=${state.motion.code} に ${turnIndex + 1} 件目が無い。`,
      { motionCode: state.motion.code, turnIndex, available: questions.length },
    );
  }

  // 経路の判定は状態機械が持つ（設計 §11 AUTO_FILL）。通らなければ1行も書かない
  const args = argumentInventoryOf(await repository.listArguments(params.matchId));
  const transition = reduce(state, {
    type: 'AUTO_FILL',
    expectedVersion: params.expectedVersion,
    args,
  });
  if (!transition.ok) {
    return failure(transition.error.code, transition.error.message, transition.error.details);
  }

  // 同じ往復に行があるのは、前回の保存後に遷移が確定しなかったときである。
  // UNIQUE(match_id, section_no, turn_index) に当たらないよう書き直さない。
  const cxTurns = await repository.listCxTurns(params.matchId);
  const already = cxTurns.some(
    (turn) => turn.sectionNo === slot.sectionNo && turn.turnIndex === turnIndex,
  );
  if (!already) {
    const record: CxTurnRecord = {
      id: deps.newId('cx_turn'),
      matchId: state.id,
      sectionNo: slot.sectionNo,
      turnIndex,
      askedBySeat: slot.actorSeat,
      answeredBySeat: slot.respondentSeat,
      questionText,
      answerText: null,
      // 参照できる論点が無い（設計 §10）
      targetArgumentKey: null,
      concessionArgumentKey: null,
      truncated: false,
    };
    await repository.insertCxTurn(record);
  }

  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}
