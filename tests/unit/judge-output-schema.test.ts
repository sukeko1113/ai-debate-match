import { describe, expect, it } from 'vitest';

import {
  LEARNER_AXES,
  LEARNER_SCORE_TOTAL,
  MATCH_AXES,
  MATCH_SCORE_TOTAL,
  MAX_NEW_ARGUMENT_QUOTE_LENGTH,
  buildJudgeOutputSchema,
} from '@/schemas/ai-output';

/**
 * 判定の出力（設計 §16.1 / §16.2 / §16.3 / §21.1）。
 *
 * **満点も軸の名前もコード側が決める。** 根拠のセクションが無い出力は通さない。
 */

const SECTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const KEYS = ['AD1', 'AD2', 'DA1', 'DA2'];

const schema = buildJudgeOutputSchema({
  sectionNos: SECTIONS,
  argumentKeys: KEYS,
  learnerSeat: 'A1',
});

const matchAxes = (overrides: Partial<Record<string, unknown>>[] = []) =>
  MATCH_AXES.map((axis, position) => ({
    axis: axis.axis,
    score: 10,
    max: axis.max,
    reason: '理由',
    sectionIds: [1],
    ...(overrides[position] ?? {}),
  }));

const learnerAxes = (overrides: Partial<Record<string, unknown>>[] = []) =>
  LEARNER_AXES.map((axis, position) => ({
    axis: axis.axis,
    score: 10,
    max: axis.max,
    reason: '理由',
    sectionIds: [1],
    ...(overrides[position] ?? {}),
  }));

function output(overrides: {
  matchAxes?: unknown[];
  learnerAxes?: unknown[];
  votingIssues?: unknown[];
  findings?: unknown[];
  confidence?: number | null;
  seat?: string;
} = {}) {
  return {
    match: {
      winner: 'affirmative',
      confidence: overrides.confidence === undefined ? 0.7 : overrides.confidence,
      needsReview: false,
      hasValidConstructive: { affirmative: true, negative: true },
      votingIssues: overrides.votingIssues ?? [
        { title: '争点', winner: 'affirmative', reason: '理由', sectionIds: [1, 7] },
      ],
      axes: overrides.matchAxes ?? matchAxes(),
    },
    newArgumentFindings: overrides.findings ?? [],
    learnerReport: {
      seat: overrides.seat ?? 'A1',
      sectionsCovered: [1, 2],
      axes: overrides.learnerAxes ?? learnerAxes(),
      strengths: ['よかった点'],
      nextActions: ['次にやること'],
    },
  };
}

describe('配点はコード側が決める（設計 §16.1 / §16.2）', () => {
  it('4軸と3軸の満点の合計は 85 と 65 である', () => {
    expect(MATCH_AXES.reduce((sum, axis) => sum + axis.max, 0)).toBe(MATCH_SCORE_TOTAL);
    expect(LEARNER_AXES.reduce((sum, axis) => sum + axis.max, 0)).toBe(LEARNER_SCORE_TOTAL);
  });

  it('正しい形は通る', () => {
    expect(schema.safeParse(output()).success).toBe(true);
  });

  it('満点を書き換えた出力は落ちる', () => {
    const tampered = matchAxes([{ max: 30 }]);
    expect(schema.safeParse(output({ matchAxes: tampered })).success).toBe(false);
  });

  it('軸を減らした・並べ替えた出力は落ちる', () => {
    expect(schema.safeParse(output({ matchAxes: matchAxes().slice(0, 3) })).success).toBe(false);

    const swapped = matchAxes();
    const first = swapped[0];
    const second = swapped[1];
    if (first === undefined || second === undefined) throw new Error('軸が足りない');
    expect(
      schema.safeParse(output({ matchAxes: [second, first, ...swapped.slice(2)] })).success,
    ).toBe(false);
  });

  it('満点を超える得点は落ちる', () => {
    expect(schema.safeParse(output({ matchAxes: matchAxes([{ score: 26 }]) })).success).toBe(false);
  });

  it('学習者レポートの軸も同じ規則で守る', () => {
    expect(schema.safeParse(output({ learnerAxes: learnerAxes([{ max: 30 }]) })).success).toBe(
      false,
    );
    expect(schema.safeParse(output({ learnerAxes: learnerAxes().slice(0, 2) })).success).toBe(
      false,
    );
  });
});

describe('根拠のセクションが必須である（設計 §16.3 / §21.1）', () => {
  it('sectionIds が空の軸は落ちる', () => {
    expect(schema.safeParse(output({ matchAxes: matchAxes([{ sectionIds: [] }]) })).success).toBe(
      false,
    );
    expect(
      schema.safeParse(output({ learnerAxes: learnerAxes([{ sectionIds: [] }]) })).success,
    ).toBe(false);
  });

  it('sectionIds が空の争点は落ちる', () => {
    const issues = [{ title: '争点', winner: 'affirmative', reason: '理由', sectionIds: [] }];
    expect(schema.safeParse(output({ votingIssues: issues })).success).toBe(false);
  });

  it('実在しないセクション番号は落ちる', () => {
    expect(schema.safeParse(output({ matchAxes: matchAxes([{ sectionIds: [13] }]) })).success).toBe(
      false,
    );
  });

  it('理由の無い軸は落ちる', () => {
    expect(schema.safeParse(output({ matchAxes: matchAxes([{ reason: '' }]) })).success).toBe(
      false,
    );
  });
});

describe('newArgumentFindings（設計 §9.2）', () => {
  it('既存keyを名乗る指摘は通る', () => {
    const findings = [
      { sectionNo: 5, claimedArgumentKey: 'AD1', quote: '引用', reason: '独立した主張である' },
    ];
    expect(schema.safeParse(output({ findings })).success).toBe(true);
  });

  it('未知の argument_key は落ちる（設計 §15.6）', () => {
    const findings = [
      { sectionNo: 5, claimedArgumentKey: 'AD9', quote: '引用', reason: '理由' },
    ];
    expect(schema.safeParse(output({ findings })).success).toBe(false);
  });

  it('引用が120字を超えると落ちる', () => {
    const findings = [
      {
        sectionNo: 5,
        claimedArgumentKey: 'AD1',
        quote: 'あ'.repeat(MAX_NEW_ARGUMENT_QUOTE_LENGTH + 1),
        reason: '理由',
      },
    ];
    expect(schema.safeParse(output({ findings })).success).toBe(false);
  });

  it('論点が0件の試合では指摘そのものが作れない', () => {
    const noKeys = buildJudgeOutputSchema({
      sectionNos: SECTIONS,
      argumentKeys: [],
      learnerSeat: 'A1',
    });
    expect(noKeys.safeParse(output()).success).toBe(true);
    const findings = [
      { sectionNo: 5, claimedArgumentKey: 'AD1', quote: '引用', reason: '理由' },
    ];
    expect(noKeys.safeParse(output({ findings })).success).toBe(false);
  });
});

describe('その他の不変条件（設計 §16.3）', () => {
  it('confidence は null を許す（論点0件のとき）', () => {
    expect(schema.safeParse(output({ confidence: null })).success).toBe(true);
  });

  it('confidence が範囲外なら落ちる', () => {
    expect(schema.safeParse(output({ confidence: 1.5 })).success).toBe(false);
  });

  it('学習者以外の席のレポートは落ちる', () => {
    expect(schema.safeParse(output({ seat: 'N1' })).success).toBe(false);
  });

  it('引き分けは作れない（winner は肯定・否定のどちらか）', () => {
    const draw = { ...output(), match: { ...output().match, winner: 'draw' } };
    expect(schema.safeParse(draw).success).toBe(false);
  });
});
