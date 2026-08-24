import { z } from 'zod';

import { sideSchema, type Seat } from '../common';

import { referenceEnum } from './references';

/**
 * 判定と学習者レポートの出力（設計 §16.1 / §16.2 / §16.3 / §9.2）。
 *
 * **満点も軸の名前もコード側が決める。AIには決めさせない。** AIが返すのは各軸の得点と
 * その根拠であり、配点そのものを動かせてしまうと採点基準が試合ごとに変わる。
 *
 * 根拠のセクション番号（`sectionIds`）は必ず1件以上で、rule set に実在する番号でなければ
 * ならない（設計 §21.1）。数字だけを返して根拠を示さない出力は棄却する。
 *
 * `newArgumentFindings` は設計 §9 の第2層である。第1層（未知keyの棄却）は P6 が持つ。
 */

/** 試合の暫定判定（設計 §16.1）。合計85点 */
export const MATCH_AXES = [
  { axis: 'logic', max: 25 },
  { axis: 'evidence', max: 20 },
  { axis: 'rebuttal', max: 20 },
  { axis: 'cx', max: 20 },
] as const;

/** 学習者レポート（設計 §16.2）。合計65点。対象は学習者の担当セクションだけ */
export const LEARNER_AXES = [
  { axis: 'constructive_structure', max: 25 },
  { axis: 'evidence_use', max: 20 },
  { axis: 'cx_response', max: 20 },
] as const;

export const MATCH_SCORE_TOTAL = 85;
export const LEARNER_SCORE_TOTAL = 65;

/** 設計 §9.2 newArgumentFindings.quote */
export const MAX_NEW_ARGUMENT_QUOTE_LENGTH = 120;

/** 設計 §16.3。この値を下回ると needsReview になる */
export const LOW_CONFIDENCE_THRESHOLD = 0.65;

export type MatchAxisName = (typeof MATCH_AXES)[number]['axis'];
export type LearnerAxisName = (typeof LEARNER_AXES)[number]['axis'];

export type JudgeAxis = {
  readonly axis: string;
  readonly score: number;
  readonly max: number;
  readonly reason: string;
  readonly sectionIds: readonly number[];
};

export type VotingIssue = {
  readonly title: string;
  readonly winner: 'affirmative' | 'negative';
  readonly reason: string;
  readonly sectionIds: readonly number[];
};

export type NewArgumentFinding = {
  readonly sectionNo: number;
  readonly claimedArgumentKey: string;
  readonly quote: string;
  readonly reason: string;
};

export type JudgeOutput = {
  readonly match: {
    readonly winner: 'affirmative' | 'negative';
    readonly confidence: number | null;
    readonly needsReview: boolean;
    readonly hasValidConstructive: {
      readonly affirmative: boolean;
      readonly negative: boolean;
    };
    readonly votingIssues: readonly VotingIssue[];
    readonly axes: readonly JudgeAxis[];
  };
  readonly newArgumentFindings: readonly NewArgumentFinding[];
  readonly learnerReport: {
    readonly seat: string;
    readonly sectionsCovered: readonly number[];
    readonly axes: readonly JudgeAxis[];
    readonly strengths: readonly string[];
    readonly nextActions: readonly string[];
  };
};

export type JudgeSchemaParams = {
  /** rule set に実在する競技セクション番号（設計 §21.1） */
  readonly sectionNos: readonly number[];
  /** 既存の argument key。findings はこの部分集合しか名乗れない（設計 §9.2） */
  readonly argumentKeys: readonly string[];
  /** 学習者の席（Phase 1 では A1） */
  readonly learnerSeat: Seat;
};

/** 実在するセクション番号だけを受ける（設計 §21.1） */
function sectionIdSchema(sectionNos: readonly number[]): z.ZodType<number> {
  return z
    .number()
    .int()
    .refine((value) => sectionNos.includes(value), {
      error: `rule set に無いセクション番号である（実在するのは ${sectionNos.join(', ')}）`,
    }) as unknown as z.ZodType<number>;
}

/** 根拠は必ず1件以上。数字だけを返して根拠を隠す出力は通さない（設計 §16.3） */
function sectionIdsSchema(sectionNos: readonly number[], label: string) {
  return z.array(sectionIdSchema(sectionNos)).min(1, {
    error: `${label} には根拠となるセクションが1件以上必要である（設計 §16.3）`,
  });
}

/**
 * 軸の並び。**名前と満点は固定**で、AIが返せるのは score と根拠だけである。
 * 順序も固定する。並べ替えで配点が入れ替わるのを防ぐ。
 */
function axesSchema(
  axes: ReadonlyArray<{ readonly axis: string; readonly max: number }>,
  sectionNos: readonly number[],
  label: string,
) {
  return z
    .array(
      z.strictObject({
        axis: z.string().min(1),
        score: z.number().int().min(0),
        max: z.number().int(),
        reason: z.string().min(1, { error: `${label} の各軸には理由が必要である（設計 §16.3）` }),
        sectionIds: sectionIdsSchema(sectionNos, `${label} の軸`),
      }),
    )
    .length(axes.length, { error: `${label} は${axes.length}軸である（設計 §16）` })
    .superRefine((values, ctx) => {
      axes.forEach((expected, position) => {
        const actual = values[position];
        if (actual === undefined) return;
        if (actual.axis !== expected.axis) {
          ctx.addIssue({
            code: 'custom',
            path: [position, 'axis'],
            message: `${position + 1}番目の軸は ${expected.axis} である（設計 §16）`,
          });
        }
        if (actual.max !== expected.max) {
          ctx.addIssue({
            code: 'custom',
            path: [position, 'max'],
            message: `${expected.axis} の満点は ${expected.max} である。満点はAIが決めない（設計 §16）`,
          });
        }
        if (actual.score > expected.max) {
          ctx.addIssue({
            code: 'custom',
            path: [position, 'score'],
            message: `${expected.axis} の得点は満点 ${expected.max} を超えられない`,
          });
        }
      });
    });
}

/**
 * 判定の出力（設計 §16.3）。
 *
 * `confidence` は null を許す。論点0件で勝者が自動的に決まる場合、
 * 確信度という概念が成り立たないためである（設計 §10）。
 */
export function buildJudgeOutputSchema(params: JudgeSchemaParams): z.ZodType<JudgeOutput> {
  const { sectionNos } = params;

  const findingSchema =
    params.argumentKeys.length === 0
      ? z.array(z.never()).max(0, {
          error: '参照できる論点が無い試合では newArgumentFindings は空である（設計 §9.2）',
        })
      : z.array(
          z.strictObject({
            sectionNo: sectionIdSchema(sectionNos),
            claimedArgumentKey: referenceEnum(params.argumentKeys, 'claimedArgumentKey'),
            quote: z
              .string()
              .min(1)
              .max(MAX_NEW_ARGUMENT_QUOTE_LENGTH, {
                error: `quote は${MAX_NEW_ARGUMENT_QUOTE_LENGTH}字以内である（設計 §9.2）`,
              }),
            reason: z.string().min(1),
          }),
        );

  return z.strictObject({
    match: z.strictObject({
      // 引き分けは作らない（設計 §16.3）
      winner: sideSchema,
      confidence: z.number().min(0).max(1).nullable(),
      needsReview: z.boolean(),
      hasValidConstructive: z.strictObject({
        affirmative: z.boolean(),
        negative: z.boolean(),
      }),
      votingIssues: z.array(
        z.strictObject({
          title: z.string().min(1),
          winner: sideSchema,
          reason: z.string().min(1),
          sectionIds: sectionIdsSchema(sectionNos, 'votingIssues'),
        }),
      ),
      axes: axesSchema(MATCH_AXES, sectionNos, '試合の判定'),
    }),
    newArgumentFindings: findingSchema.default([]),
    learnerReport: z.strictObject({
      seat: z.literal(params.learnerSeat),
      sectionsCovered: z.array(sectionIdSchema(sectionNos)).min(1),
      axes: axesSchema(LEARNER_AXES, sectionNos, '学習者レポート'),
      strengths: z.array(z.string().min(1)),
      nextActions: z
        .array(z.string().min(1))
        .min(1, { error: 'nextActions は1件以上である（設計 §16.3）' }),
    }),
  }) as unknown as z.ZodType<JudgeOutput>;
}

/** 得点の合計。表示と検証で同じ計算を使う */
export function totalScore(axes: readonly JudgeAxis[]): number {
  return axes.reduce((sum, axis) => sum + axis.score, 0);
}
