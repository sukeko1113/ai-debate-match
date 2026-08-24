import { expect, test, type Page } from '@playwright/test';

/**
 * 完走から判定・Result まで（設計 §16 / §5.1 / 付録D / §21.3 E01）。
 *
 * 立論1件と質疑の回答を人間が出し、あとは進行ボタンを押し続ける。
 * 判定を実行すると Result へ移り、85点と65点が**根拠つき**で出る。
 *
 * AI Provider は mock である（`AI_PROVIDER=mock`）。
 */

const PLAYER_NAME = 'テスト太郎';
const ARGUMENT = {
  label: '学習時間が増える',
  body: '現在は部活動が長時間に及ぶ。選択制にすれば学習時間が増える。',
};

/** 保存状態の version 表示。サーバが1歩進んだことの目印にする */
function versionText(page: Page) {
  return page.locator('.slot-facts dd').last();
}

/** 画面に出ているボタンを1つ押し、version が変わるまで待つ */
async function stepOnce(page: Page): Promise<boolean> {
  const answerForm = page.getByRole('heading', { name: /質疑に答える/ });
  if ((await answerForm.count()) > 0) {
    const version = versionText(page);
    const before = await version.innerText();
    await page.getByLabel('あなたの回答').fill('結論から申し上げます。成り立ちます。');
    await page.getByRole('button', { name: '回答を送る' }).click();
    await expect(version).not.toHaveText(before);
    return true;
  }

  for (const label of ['次へ進む', '準備を終える']) {
    const button = page.getByRole('button', { name: label });
    if ((await button.count()) === 0) continue;
    const version = versionText(page);
    const before = await version.innerText();
    await button.click();
    await expect(version).not.toHaveText(before);
    return true;
  }
  return false;
}

/** 立論を出してから、判定ボタンが出るまで進める */
async function driveToJudge(page: Page) {
  await page.goto('/matches/new');
  await page.getByLabel('あなたの表示名（肯定側A1）').fill(PLAYER_NAME);
  await page.getByRole('button', { name: '試合を作成する' }).click();

  await expect(page).toHaveURL(/\/matches\/match_/);
  await page.getByRole('button', { name: '第1セクションを始める' }).click();
  await page.getByRole('button', { name: '次へ進む' }).click();

  const first = page.getByRole('group', { name: /論点1/ });
  await first.getByLabel('タイトル').fill(ARGUMENT.label);
  await first.getByLabel('本文').fill(ARGUMENT.body);
  await first.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: '立論を提出する' }).click();
  await expect(page.getByRole('heading', { name: '提出済みの本文' })).toBeVisible();

  const judgeButton = page.getByRole('button', { name: '判定を実行する' });
  for (let step = 0; step < 80; step += 1) {
    if ((await judgeButton.count()) > 0) return;
    if (!(await stepOnce(page))) break;
  }
  await expect(judgeButton).toBeVisible();
}

test('E01: 完走して判定すると、85点と65点が根拠つきで出る', async ({ page }) => {
  test.setTimeout(120_000);
  await driveToJudge(page);

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
  await expect(page.getByRole('link', { name: 'この試合のJSONを取得する' })).toBeVisible();
});

test('判定前の Result は Match Room へ戻す（設計 §14.4）', async ({ page }) => {
  await page.goto('/matches/new');
  await page.getByLabel('あなたの表示名（肯定側A1）').fill(PLAYER_NAME);
  await page.getByRole('button', { name: '試合を作成する' }).click();
  await expect(page).toHaveURL(/\/matches\/match_/);

  const matchUrl = page.url();
  await page.goto(`${matchUrl}/result`);

  await expect(page.getByText('まだ判定していません')).toBeVisible();
  await page.getByRole('link', { name: 'Match Room へ戻る' }).click();
  await expect(page).toHaveURL(matchUrl);
});
