import { expect, test } from '@playwright/test';

import {
  driveToConstructiveForm,
  driveToJudge,
  exportOf,
  fillConstructive,
  humanInput,
  sectionText,
  stepOnce,
  stepUntil,
  submitConstructive,
} from '../support/drive';

/**
 * E01 基本完走 / E02 再読込 / E03 二重送信（設計 §21.3）。
 *
 * 人間の入力は `content/fixtures/e2e-human-input.json` から読む（設計 §15.7）。
 * 進行はサーバが決める。画面は出ているボタンを押すだけである。
 */

test.describe('E01 基本完走', () => {
  test('E01: Setup→立論→質疑の回答→AI各役→Judge→Result まで通り、85点と65点が根拠つきで出る', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const matchUrl = await driveToJudge(page);

    await page.getByRole('button', { name: '判定を実行する' }).click();
    await expect(page).toHaveURL(/\/matches\/match_.*\/result$/);

    // 付録D: 暫定評価であることを必ず出す
    await expect(page.getByText('公式ジャッジではありません')).toBeVisible();

    await expect(page.getByRole('heading', { name: '暫定判定' })).toBeVisible();
    await expect(page.getByText('/ 85')).toBeVisible();
    await expect(page.getByRole('heading', { name: '学習者レポート' })).toBeVisible();
    await expect(page.getByText('/ 65')).toBeVisible();

    // 数字だけを出さない。各軸に根拠のセクションが並ぶ（設計 §16.3）
    const matchAxes = page.getByRole('table', { name: /試合の暫定判定/ });
    await expect(matchAxes.getByRole('rowheader', { name: '論理構成' })).toBeVisible();
    await expect(matchAxes.getByText('セクション').first()).toBeVisible();
    const learnerAxes = page.getByRole('table', { name: /学習者レポート/ });
    await expect(learnerAxes.getByRole('rowheader', { name: '立論の構成' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '次にやること' })).toBeVisible();

    // 17スロットすべてが確定し、judged になっている（設計 §3.1）
    const exported = (await exportOf(page.request, matchUrl)) as {
      match: { status: string; progress: ReadonlyArray<{ status: string }> };
      arguments: ReadonlyArray<unknown>;
    };
    expect(exported.match.status).toBe('judged');
    expect(exported.match.progress).toHaveLength(17);
    expect(exported.match.progress.filter((slot) => slot.status === 'pending')).toHaveLength(0);
    // arguments は常に4件以下（設計 §3.2）
    expect(exported.arguments.length).toBeLessThanOrEqual(4);
  });
});

test.describe('E02 再読込', () => {
  test('E02: 立論の確定後に再読込しても、同じスロットと保存済み内容へ戻る', async ({ page }) => {
    await driveToConstructiveForm(page);
    await submitConstructive(page);

    const before = page.url();
    await page.reload();

    expect(page.url()).toBe(before);
    await expect(sectionText(page)).toHaveText('第1セクション／立論');
    await expect(page.getByText('私は論題に賛成します。')).toBeVisible();
    // 確定した出力は編集できない（設計 §18.1）
    await expect(page.getByRole('heading', { name: '立論を入力する' })).toHaveCount(0);
  });

  test('E02: 質疑の cursor=1 で再読込しても、同じ slot・同じ cursor・保存済み履歴へ戻る', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await driveToConstructiveForm(page);
    await submitConstructive(page);

    // 1往復目の回答待ちまで進め、答える
    const firstAnswer = await stepUntil(
      page,
      async (target) => (await target.getByRole('heading', { name: /質疑に答える/ }).count()) > 0,
    );
    expect(firstAnswer).toBe(true);
    await stepOnce(page, 0);

    // 2往復目の回答待ち（cursor=1）まで進める。見出しに往復位置が出る（設計 §18.1）
    const secondAnswer = await stepUntil(
      page,
      async (target) =>
        (await target.getByRole('heading', { name: '質疑に答える（質問 2/3）' }).count()) > 0,
    );
    expect(secondAnswer).toBe(true);
    await expect(page.getByText('質疑 2/3（回答）')).toBeVisible();
    const question = await page.locator('form blockquote.cx-question').innerText();
    const before = page.url();

    await page.reload();

    expect(page.url()).toBe(before);
    await expect(sectionText(page)).toHaveText('第2セクション／質疑');
    await expect(page.getByText('質疑 2/3（回答）')).toBeVisible();
    await expect(page.locator('form blockquote.cx-question')).toHaveText(question);
    // 1往復目の履歴が残っている
    await expect(page.locator('.cx-turns > li')).toHaveCount(2);
    await expect(page.locator('.cx-turns > li').first().locator('.cx-answer')).toHaveText(
      humanInput.cxAnswers[0] ?? '',
    );
  });
});

test.describe('E03 二重送信', () => {
  test('E03: 立論の提出を2回続けて押しても、speech は1件だけである', async ({ page }) => {
    const matchUrl = await driveToConstructiveForm(page);
    await fillConstructive(page);

    const submit = page.getByRole('button', { name: '立論を提出する' });

    // 2回押す。2回目は送信中で無効か、サーバが expectedVersion で弾く（設計 §11）
    await submit.click();
    await submit.click({ force: true, noWaitAfter: true }).catch(() => undefined);
    await expect(page.getByRole('heading', { name: '提出済みの本文' })).toBeVisible();

    const exported = (await exportOf(page.request, matchUrl)) as {
      speeches: ReadonlyArray<{ sectionNo: number }>;
      arguments: ReadonlyArray<unknown>;
    };
    expect(exported.speeches.filter((speech) => speech.sectionNo === 1)).toHaveLength(1);
    // 採番も二重にならない（設計 §8.2）
    expect(exported.arguments).toHaveLength(humanInput.constructive.arguments.length);
  });
});
