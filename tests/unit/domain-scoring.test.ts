import { describe, expect, it } from 'vitest';

import {
  NO_CONSTRUCTIVE_REASON,
  excludeFindings,
  findingViolations,
  forcedWinnerOf,
  hasValidConstructiveOf,
  judgedSpeechesOf,
  needsReviewReasons,
  type JudgedSpeech,
} from '@/domain/scoring';
import { LEARNER_AXES, MATCH_AXES, type JudgeOutput } from '@/schemas/ai-output';

/**
 * 判定の検証と補正（設計 §16.3 / §9.2 / §10）。
 *
 * AIが返すのは得点と根拠だけである。勝敗の前提と `needsReview` はサーバが決める。
 */

const SPEECHES: JudgedSpeech[] = [
  {
    sectionNo: 5,
    side: 'negative',
    text: '肯定側の第1論点に反論します。さらに、地域社会との関係が失われるという問題もあります。',
    autoFilled: false,
  },
  { sectionNo: 7, side: 'affirmative', text: '否定側の第1論点に反論します。', autoFilled: false },
  { sectionNo: 9, side: 'affirmative', text: '対象がありません。', autoFilled: true },
];

const bothSides = { affirmative: ['AD1'], negative: ['DA1'] };
const affirmativeOnly = { affirmative: ['AD1'], negative: [] };
const negativeOnly = { affirmative: [], negative: ['DA1'] };

function judgeOutput(overrides: Partial<JudgeOutput['match']> = {}): JudgeOutput {
  return {
    match: {
      winner: 'affirmative',
      confidence: 0.8,
      needsReview: false,
      hasValidConstructive: { affirmative: true, negative: true },
      votingIssues: [],
      axes: MATCH_AXES.map((axis) => ({
        axis: axis.axis,
        score: 1,
        max: axis.max,
        reason: '理由',
        sectionIds: [1],
      })),
      ...overrides,
    },
    newArgumentFindings: [],
    learnerReport: {
      seat: 'A1',
      sectionsCovered: [1, 2],
      axes: LEARNER_AXES.map((axis) => ({
        axis: axis.axis,
        score: 1,
        max: axis.max,
        reason: '理由',
        sectionIds: [1],
      })),
      strengths: [],
      nextActions: ['次にやること'],
    },
  };
}

describe('立論の有無はサーバが決める（設計 §10）', () => {
  it('件数から hasValidConstructive を出す', () => {
    expect(hasValidConstructiveOf(bothSides)).toEqual({ affirmative: true, negative: true });
    expect(hasValidConstructiveOf(negativeOnly)).toEqual({ affirmative: false, negative: true });
  });

  it('論点0件の側は勝てない', () => {
    expect(forcedWinnerOf(negativeOnly)).toBe('negative');
    expect(forcedWinnerOf(affirmativeOnly)).toBe('affirmative');
    expect(forcedWinnerOf(bothSides)).toBeNull();
    // 両側0件は判定そのものを実行しない（decideJudgeOutcome の領分）
    expect(forcedWinnerOf({ affirmative: [], negative: [] })).toBeNull();
  });
});

describe('自動充填は発話なしとして扱う（設計 §10.2）', () => {
  it('判定材料から外れる', () => {
    const judged = judgedSpeechesOf(SPEECHES);
    expect(judged.map((speech) => speech.sectionNo)).toEqual([5, 7]);
  });
});

describe('newArgumentFindings の検証（設計 §9.2 / §21.1）', () => {
  const finding = {
    sectionNo: 5,
    claimedArgumentKey: 'AD1',
    quote: 'さらに、地域社会との関係が失われるという問題もあります。',
    reason: '独立した新しい不利益である。',
  };

  it('原文にある引用は通る', () => {
    expect(findingViolations([finding], SPEECHES)).toEqual([]);
  });

  it('原文に無い引用は落ちる。AIに引用を作らせない', () => {
    const invented = { ...finding, quote: '原文にはこの文はありません。' };
    expect(findingViolations([invented], SPEECHES)).toHaveLength(1);
  });

  it('空白の違いだけでは落とさない', () => {
    const spaced = { ...finding, quote: 'さらに、地域社会との関係が \n 失われるという問題もあります。' };
    expect(findingViolations([spaced], SPEECHES)).toEqual([]);
  });

  it('発話の無いセクションを指す指摘は落ちる', () => {
    expect(findingViolations([{ ...finding, sectionNo: 11 }], SPEECHES)).toHaveLength(1);
  });

  it('該当箇所だけを外す。スピーチ全体は外さない', () => {
    const excluded = excludeFindings(SPEECHES, [finding]);
    const fifth = excluded.speeches.find((speech) => speech.sectionNo === 5);
    expect(fifth?.text).toBe('肯定側の第1論点に反論します。');
    expect(excluded.excludedSections).toEqual([5]);

    // 指摘のないスピーチは変わらない
    expect(excluded.speeches.find((speech) => speech.sectionNo === 7)?.text).toBe(
      '否定側の第1論点に反論します。',
    );
  });
});

describe('needsReview はサーバが決める（設計 §16.3）', () => {
  const base = { excludedSections: [], excludedSidesOfWinner: false };

  it('通常系で確信度が高ければ見直しは要らない', () => {
    expect(needsReviewReasons({ output: judgeOutput(), args: bothSides, ...base })).toEqual([]);
  });

  it('確信度が 0.65 を下回ると見直しになる', () => {
    const reasons = needsReviewReasons({
      output: judgeOutput({ confidence: 0.5 }),
      args: bothSides,
      ...base,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('確信度');
  });

  it('立論未提出は理由に明記される（設計 §10）', () => {
    const reasons = needsReviewReasons({
      output: judgeOutput({ winner: 'negative', confidence: null }),
      args: negativeOnly,
      ...base,
    });
    expect(reasons).toContain(NO_CONSTRUCTIVE_REASON.affirmative);
  });

  it('AIが見直しを求めたなら、サーバはそれを消さない', () => {
    const reasons = needsReviewReasons({
      output: judgeOutput({ needsReview: true }),
      args: bothSides,
      ...base,
    });
    expect(reasons).toHaveLength(1);
  });

  it('除外が勝者側に及んだら見直しになる（設計 §9.2）', () => {
    const reasons = needsReviewReasons({
      output: judgeOutput(),
      args: bothSides,
      excludedSections: [7],
      excludedSidesOfWinner: true,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('New Argument');
  });

  it('除外が敗者側だけなら、それだけでは見直しにしない', () => {
    const reasons = needsReviewReasons({
      output: judgeOutput(),
      args: bothSides,
      excludedSections: [5],
      excludedSidesOfWinner: false,
    });
    expect(reasons).toEqual([]);
  });
});
