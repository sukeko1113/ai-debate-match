import { expect, test } from '@playwright/test';

import {
  driveToConstructiveForm,
  exportOf,
  snapshotOf,
  stepUntil,
  submitConstructive,
} from '../support/drive';

/**
 * E08 budget（設計 §21.3 / §17）。
 *
 * この project は `MAX_AI_RUNS_PER_MATCH=5` で起動する。通常系は29回を要するので、
 * 途中で必ず上限に当たる。**当たっても履歴は残る。**
 */

test('E08: AI実行回数の上限に当たると止まり、それまでの履歴は残る', async ({ page }) => {
  test.setTimeout(120_000);
  const matchUrl = await driveToConstructiveForm(page);
  await submitConstructive(page);

  // 上限に当たるまで進める。エラーは画面上部に出る（設計 §18.1）
  const stopped = await stepUntil(
    page,
    async (target) => (await target.locator('p.error[role="alert"]').count()) > 0,
    60,
  );
  expect(stopped).toBe(true);
  await expect(page.locator('p.error[role="alert"]')).toContainText('上限');

  // 429 で返っている（設計 §14.4 MATCH_BUDGET_EXCEEDED）
  const snapshot = await snapshotOf(page.request, matchUrl);
  const matchId = matchUrl.split('/matches/')[1] ?? '';
  const response = await page.request.post(`/api/matches/${matchId}/advance`, {
    data: { expectedVersion: snapshot.version },
  });
  expect(response.status()).toBe(429);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe('MATCH_BUDGET_EXCEEDED');

  // 履歴は消えない（設計 §21.3 E08「履歴保持」）
  const exported = (await exportOf(page.request, matchUrl)) as {
    speeches: ReadonlyArray<unknown>;
    arguments: ReadonlyArray<unknown>;
    aiRuns: ReadonlyArray<{ status: string }>;
    auditLogs: ReadonlyArray<unknown>;
  };
  expect(exported.speeches.length).toBeGreaterThan(0);
  expect(exported.arguments.length).toBeGreaterThan(0);
  expect(exported.auditLogs.length).toBeGreaterThan(0);
  // 上限は成功runで数える（設計 §17）
  expect(exported.aiRuns.filter((run) => run.status === 'succeeded')).toHaveLength(5);

  // 再読込しても同じ状態へ戻る
  await page.reload();
  await expect(page.getByText('Match Room')).toBeVisible();
});
