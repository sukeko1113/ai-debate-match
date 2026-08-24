import {
  budgetProblemOf,
  failure,
  generateWithRetries,
  type AiGenerationDeps,
  type GenerationFailure,
} from '@/application/run-slot';
import { argumentInventoryOf } from '@/domain/arguments';
import { reduce, type MatchState } from '@/domain/match';
import type { JudgingRunRecord } from '@/domain/repositories';
import {
  NO_CONSTRUCTIVE_REASON,
  excludeFindings,
  findingViolations,
  forcedWinnerOf,
  hasValidConstructiveOf,
  judgedSpeechesOf,
  needsReviewReasons,
} from '@/domain/scoring';
import {
  LEARNER_AXES,
  LEARNER_SCORE_TOTAL,
  MATCH_AXES,
  MATCH_SCORE_TOTAL,
  buildJudgeOutputSchema,
  totalScore,
  type JudgeOutput,
} from '@/schemas/ai-output';
import { PROVISIONAL_NOTICE, parseJudgeResult, type JudgeResult } from '@/schemas/api';
import { seatSide, type Seat } from '@/schemas/common';

import { buildJudgeInput, toJudgedSpeeches } from './judge-input';

/**
 * 試合の判定（設計 §16 / §11 JUDGE / §14.3）。
 *
 * **同期で1回だけ実行する。** ジョブキューは使わない（CLAUDE.md 禁止事項）。
 * 同じ `rubric_version` では二度採点しない（設計 §13 / §21.2）。既に判定済みなら
 * 保存済みの結果をそのまま返し、AIを呼ばない。
 *
 * AIが返すのは得点と根拠だけである。**勝敗の前提・`confidence` の打ち消し・
 * `needsReview` はサーバが決める**（設計 §10 / §16.3 / CLAUDE.md 禁止事項）。
 */

/** 採点基準の版。配点や軸を変えたら上げる（設計 §13 judging_runs） */
export const RUBRIC_VERSION = 'p9.1';

/** 判定は特定のスロットに属さない。`ai_runs.slot_index` の別枠として -1 を使う */
const JUDGE_SLOT_INDEX = -1;

export type JudgeMatchDeps = AiGenerationDeps;

export type JudgeMatchParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type JudgeMatchResult =
  | { readonly ok: true; readonly state: MatchState; readonly result: JudgeResult }
  | GenerationFailure;

/** Phase 1 の学習者は A1 だけである（設計 §4 / §16.2） */
function learnerSeatOf(state: MatchState): Seat {
  const human = state.seats.find((seat) => seat.occupantType === 'human');
  return human?.seat ?? 'A1';
}

/**
 * サーバが確定させた結果を組み立てる（設計 §16.3 / §9.2 / §10）。
 *
 * ここで直すのは3つだけである。
 * 1. 論点0件の側は勝てない。`confidence` は成り立たないので null にする（設計 §10）
 * 2. `needsReview` は理由が1件でもあれば true。AIが false と言っても下げない
 * 3. 合計点はサーバが数える。AIの申告を信じない
 */
function buildResult(params: {
  readonly matchId: string;
  readonly output: JudgeOutput;
  readonly args: ReturnType<typeof argumentInventoryOf>;
  readonly excludedSections: readonly number[];
  readonly winnerSideExcluded: boolean;
}): JudgeResult {
  const { output } = params;
  const forced = forcedWinnerOf(params.args);
  const winner = forced ?? output.match.winner;
  const confidence = forced === null ? output.match.confidence : null;

  const reasons = needsReviewReasons({
    output,
    args: params.args,
    excludedSections: params.excludedSections,
    excludedSidesOfWinner: params.winnerSideExcluded,
  });

  return parseJudgeResult({
    matchId: params.matchId,
    rubricVersion: RUBRIC_VERSION,
    notice: PROVISIONAL_NOTICE,
    match: {
      winner,
      confidence,
      needsReview: reasons.length > 0,
      needsReviewReasons: reasons,
      hasValidConstructive: hasValidConstructiveOf(params.args),
      votingIssues: output.match.votingIssues,
      axes: output.match.axes,
      score: totalScore(output.match.axes),
      maxScore: MATCH_SCORE_TOTAL,
    },
    newArgumentFindings: output.newArgumentFindings,
    excludedSections: params.excludedSections,
    learnerReport: {
      ...output.learnerReport,
      score: totalScore(output.learnerReport.axes),
      maxScore: LEARNER_SCORE_TOTAL,
    },
  });
}

export async function judgeMatch(
  deps: JudgeMatchDeps,
  params: JudgeMatchParams,
): Promise<JudgeMatchResult> {
  const { repository } = deps;
  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  // 同じ採点基準では二度採点しない（設計 §21.2）。AIも呼ばない
  const stored = await repository.findJudgingRun(params.matchId, RUBRIC_VERSION);
  if (stored !== null) {
    return { ok: true, state, result: parseJudgeResult(stored.resultJson) };
  }

  if (state.status !== 'completed') {
    return failure(
      'INVALID_TRANSITION',
      `判定は completed のときだけ実行できる（いまは ${state.status}）。設計 §11`,
      { status: state.status },
    );
  }

  const overBudget = await budgetProblemOf(deps, params.matchId);
  if (overBudget !== null) return overBudget;

  const [argumentRows, cards, uses, speeches, cxTurns] = await Promise.all([
    repository.listArguments(params.matchId),
    repository.listEvidenceCards(params.matchId),
    repository.listEvidenceUses(params.matchId),
    repository.listSpeeches(params.matchId),
    repository.listCxTurns(params.matchId),
  ]);

  const args = argumentInventoryOf(argumentRows);
  const learnerSeat = learnerSeatOf(state);
  // 自動充填は『発話なし』として渡さない（設計 §10.2）
  const judged = judgedSpeechesOf(toJudgedSpeeches(speeches));

  const input = buildJudgeInput({
    state,
    learnerSeat,
    speeches,
    cxTurns,
    argumentRows,
    cards,
    uses,
    hasValidConstructive: hasValidConstructiveOf(args),
    rubric: { match: MATCH_AXES, learner: LEARNER_AXES },
  });

  const sectionNos = state.ruleSet.slots
    .map((slot) => slot.sectionNo)
    .filter((sectionNo): sectionNo is number => sectionNo !== null);
  const forced = forcedWinnerOf(args);

  const generated = await generateWithRetries<JudgeOutput>(deps, params.matchId, {
    role: 'judge',
    schema: buildJudgeOutputSchema({
      sectionNos,
      argumentKeys: argumentRows.map((row) => row.argumentKey),
      learnerSeat,
    }),
    input: input as unknown as Record<string, unknown>,
    persona: deps.personaFor(state.difficulty),
    slotIndex: JUDGE_SLOT_INDEX,
    cxTurnIndex: null,
    validate: (output) => {
      const problems = findingViolations(output.newArgumentFindings, judged);

      // 立論の有無はサーバが決める。AIの申告が食い違ったら作り直させる（設計 §10）
      const declared = hasValidConstructiveOf(args);
      if (
        output.match.hasValidConstructive.affirmative !== declared.affirmative ||
        output.match.hasValidConstructive.negative !== declared.negative
      ) {
        problems.push(
          `match.hasValidConstructive: 入力と一致しない（入力: 肯定=${declared.affirmative}, 否定=${declared.negative}）`,
        );
      }
      if (forced !== null && output.match.winner !== forced) {
        const loser = forced === 'affirmative' ? 'negative' : 'affirmative';
        problems.push(
          `match.winner: ${NO_CONSTRUCTIVE_REASON[loser]}のため勝者は ${forced} である（設計 §10）`,
        );
      }
      return problems;
    },
  });

  if (!generated.ok) return generated;

  // 指摘された箇所だけを本文から外す。スピーチ全体は外さない（設計 §9.2）
  const excluded = excludeFindings(judged, generated.output.newArgumentFindings);
  const winner = forced ?? generated.output.match.winner;
  const winnerSideExcluded = excluded.excludedSections.some(
    (sectionNo) => judged.find((speech) => speech.sectionNo === sectionNo)?.side === winner,
  );

  const result = buildResult({
    matchId: params.matchId,
    output: generated.output,
    args,
    excludedSections: excluded.excludedSections,
    winnerSideExcluded,
  });

  const record: JudgingRunRecord = {
    id: deps.newId('judging_run'),
    matchId: params.matchId,
    rubricVersion: RUBRIC_VERSION,
    provider: deps.provider.name,
    model: deps.provider.model,
    status: 'succeeded',
    resultJson: result,
    learnerReportJson: result.learnerReport,
    needsReview: result.match.needsReview,
  };
  await repository.insertJudgingRun(record);

  const transition = reduce(state, {
    type: 'JUDGE',
    expectedVersion: params.expectedVersion,
    args,
  });
  if (!transition.ok) {
    return failure(transition.error.code, transition.error.message, transition.error.details);
  }
  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());

  return { ok: true, state: transition.state, result };
}

/** Result 画面と `GET /result` が読む（設計 §14.3 / §14.4 RESULT_NOT_READY） */
export async function findJudgeResult(
  repository: JudgeMatchDeps['repository'],
  matchId: string,
): Promise<JudgeResult | null> {
  const stored = await repository.findJudgingRun(matchId, RUBRIC_VERSION);
  return stored === null ? null : parseJudgeResult(stored.resultJson);
}

/** 学習者の席の陣営。Result 画面が勝敗を言い換えるために使う */
export function learnerSideOf(state: MatchState) {
  return seatSide(learnerSeatOf(state));
}
