import { expect, test } from '@playwright/test';

import { exportOf, judgeByApi, runMatchByApi, timeoutHumanTurn } from '../support/drive';

/**
 * E11 立論未提出（設計 §21.3 / §10 / §16.2）。
 *
 * この project は `MOCK_AI_FIXTURE=no-argument` で起動する。
 * A1 は一度も入力しない。人間の手番はすべて時間切れで終える（`CLOCK_MODE=manual`）。
 *
 * 期待は設計 §21.3 の E11 の行である。
 * 「第12セクションまで完走。否定勝ち、needsReview=true、学習者レポートは質疑のみ採点」
 */

test('E11: 立論を出さないまま第12セクションまで完走し、否定勝ち・要見直しになる', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  const completed = await runMatchByApi(request, timeoutHumanTurn);
  expect(completed.status).toBe('completed');

  // 17スロットすべてが確定している（done または skipped_no_target）
  const progress = completed.progress as ReadonlyArray<{ status: string }>;
  expect(progress).toHaveLength(17);
  expect(progress.filter((slot) => slot.status === 'pending')).toHaveLength(0);
  // 肯定側の論点は0件のままである
  expect(completed.flowSheet as ReadonlyArray<{ side: string }>).toHaveLength(2);

  const result = (await judgeByApi(request, completed)) as {
    match: {
      winner: string;
      confidence: number | null;
      needsReview: boolean;
      needsReviewReasons: readonly string[];
      hasValidConstructive: { affirmative: boolean; negative: boolean };
    };
    learnerReport: {
      axes: ReadonlyArray<{ axis: string; score: number }>;
      nextActions: readonly string[];
    };
  };

  expect(result.match.winner).toBe('negative');
  expect(result.match.confidence).toBeNull();
  expect(result.match.needsReview).toBe(true);
  expect(result.match.needsReviewReasons).toContain('肯定立論未提出');
  expect(result.match.hasValidConstructive).toEqual({ affirmative: false, negative: true });

  // 学習者レポートは質疑だけを採点する（設計 §10 の学習者レポートの行）
  const axisScore = (name: string) =>
    result.learnerReport.axes.find((axis) => axis.axis === name)?.score;
  expect(axisScore('constructive_structure')).toBe(0);
  expect(axisScore('evidence_use')).toBe(0);
  expect(axisScore('cx_response')).toBeGreaterThan(0);
  expect(result.learnerReport.nextActions.length).toBeGreaterThan(0);

  // 第5・第9セクションは固定文で埋まっている（設計 §10.2）
  const matchUrl = `/matches/${String(completed.id)}`;
  const exported = (await exportOf(request, matchUrl)) as {
    speeches: ReadonlyArray<{ sectionNo: number; autoFilled: boolean }>;
  };
  expect(exported.speeches.find((speech) => speech.sectionNo === 5)?.autoFilled).toBe(true);
  expect(exported.speeches.find((speech) => speech.sectionNo === 9)?.autoFilled).toBe(true);
  expect(exported.speeches.find((speech) => speech.sectionNo === 12)).toBeDefined();

  // 画面でも結果が読める
  await page.goto(`${matchUrl}/result`);
  await expect(page.getByText('公式ジャッジではありません')).toBeVisible();
  await expect(page.getByRole('heading', { name: '見直しが必要な理由' })).toBeVisible();
  await expect(page.getByText('肯定立論未提出')).toBeVisible();
});
