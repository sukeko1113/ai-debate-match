import { z } from 'zod';

import { sideSchema } from '../common';

/**
 * Result の read model（設計 §16.3 / §5.1 / 付録D）。
 *
 * AIの出力そのものではなく、**サーバが確定させた結果**を返す。
 * `needsReview` とその理由、`confidence` の打ち消し、合計点はサーバが決める
 * （CLAUDE.md: client と AI に winner・score を確定させない）。
 *
 * 返す前に必ずこの schema を通す（設計 §14.2）。
 */

/** 付録D: 表示・出力JSON・書き出しのすべてに含める */
export const PROVISIONAL_NOTICE =
  'この判定はAIによる暫定評価であり、公式ジャッジではありません。';

const axisSchema = z.strictObject({
  axis: z.string().min(1),
  score: z.number().int().min(0),
  max: z.number().int().min(0),
  reason: z.string().min(1),
  sectionIds: z.array(z.number().int()).min(1),
});

export const judgeResultSchema = z.strictObject({
  matchId: z.string().min(1),
  /** 採点基準の版（設計 §13 judging_runs） */
  rubricVersion: z.string().min(1),
  notice: z.literal(PROVISIONAL_NOTICE),
  match: z.strictObject({
    winner: sideSchema,
    confidence: z.number().min(0).max(1).nullable(),
    needsReview: z.boolean(),
    /** なぜ見直しが要るのか。空なら needsReview は false である */
    needsReviewReasons: z.array(z.string().min(1)),
    hasValidConstructive: z.strictObject({
      affirmative: z.boolean(),
      negative: z.boolean(),
    }),
    votingIssues: z.array(
      z.strictObject({
        title: z.string().min(1),
        winner: sideSchema,
        reason: z.string().min(1),
        sectionIds: z.array(z.number().int()).min(1),
      }),
    ),
    axes: z.array(axisSchema),
    score: z.number().int().min(0),
    maxScore: z.number().int().min(0),
  }),
  newArgumentFindings: z.array(
    z.strictObject({
      sectionNo: z.number().int(),
      claimedArgumentKey: z.string().min(1),
      quote: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  /** New Argument として本文から外した箇所のあるセクション（設計 §9.2） */
  excludedSections: z.array(z.number().int()),
  learnerReport: z.strictObject({
    seat: z.string().min(1),
    sectionsCovered: z.array(z.number().int()),
    axes: z.array(axisSchema),
    strengths: z.array(z.string().min(1)),
    nextActions: z.array(z.string().min(1)),
    score: z.number().int().min(0),
    maxScore: z.number().int().min(0),
  }),
});

export type JudgeResult = z.infer<typeof judgeResultSchema>;

export function parseJudgeResult(input: unknown): JudgeResult {
  const result = judgeResultSchema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(`判定結果の検証に失敗しました:\n${z.prettifyError(result.error)}`);
}
