import { expect, test } from '@playwright/test';

/**
 * Setup と Match Room（設計 §5 / §21.3）。
 *
 * E01 の前半: Setup から試合を作り、論点2件を入力して保存できる。
 * E02: 再読込しても同じスロット・同じ保存済み内容へ戻る（設計 §3.2 画面復帰）。
 *
 * AI Provider は使わない。P5 の範囲は人間の入力までである。
 */

const PLAYER_NAME = 'テスト太郎';
const PLAN = '国が高校の部活動を選択制とする制度を導入する。';
const ARGUMENTS = [
  { label: '学習時間が増える', body: '現在は部活動が長時間に及ぶ。選択制にすれば学習時間が増える。' },
  { label: '教員の負担が減る', body: '教員は休日の指導から解放され、授業準備に時間を割ける。' },
];

/** Setup から立論の入力待ちまで進める */
async function driveToConstructiveForm(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('link', { name: '試合を始める' }).click();
  await expect(page).toHaveURL(/\/matches\/new$/);

  await page.getByLabel('あなたの表示名（肯定側A1）').fill(PLAYER_NAME);
  await page.getByRole('button', { name: '試合を作成する' }).click();

  await expect(page).toHaveURL(/\/matches\/match_/);
  await page.getByRole('button', { name: '第1セクションを始める' }).click();
  await page.getByRole('button', { name: '次へ進む' }).click();

  await expect(page.getByRole('heading', { name: '立論を入力する' })).toBeVisible();
}

test('E01前半: Setup から論点2件を入力して保存できる', async ({ page }) => {
  await driveToConstructiveForm(page);

  // 現在のセクションと担当席が、rule set の値から表示される
  await expect(page.getByText('第1セクション／立論')).toBeVisible();
  await expect(page.getByText(`A1（${PLAYER_NAME}）`)).toBeVisible();

  await page.getByLabel('プラン（任意）').fill(PLAN);

  const first = page.getByRole('group', { name: /論点1/ });
  await first.getByLabel('タイトル').fill(ARGUMENTS[0]!.label);
  await first.getByLabel('本文').fill(ARGUMENTS[0]!.body);
  // Evidence は seed のカードから選ぶ（AIには作らせない）
  await first.getByRole('checkbox').first().check();

  const second = page.getByRole('group', { name: /論点2/ });
  await expect(second.getByText('任意', { exact: true })).toBeVisible();
  await second.getByLabel('タイトル').fill(ARGUMENTS[1]!.label);
  await second.getByLabel('本文').fill(ARGUMENTS[1]!.body);

  await page.getByRole('button', { name: '立論を提出する' }).click();

  // サーバが本文を組み立て、AD1・AD2 を採番する（設計 §8.2 / §8.3）
  await expect(page.getByRole('heading', { name: '提出済みの本文' })).toBeVisible();
  await expect(page.getByText('私は論題に賛成します。')).toBeVisible();
  await expect(page.getByText(`【プラン】${PLAN}`)).toBeVisible();

  const flowSheet = page.getByRole('table');
  await expect(flowSheet.getByRole('rowheader', { name: 'AD1' })).toBeVisible();
  await expect(flowSheet.getByRole('rowheader', { name: 'AD2' })).toBeVisible();
  await expect(flowSheet.getByText(ARGUMENTS[0]!.label)).toBeVisible();

  // 確定した出力は編集できない（設計 §18.1）
  await expect(page.getByRole('heading', { name: '立論を入力する' })).toHaveCount(0);
});

test('E02: 再読込しても同じスロットと保存済み内容へ戻る', async ({ page }) => {
  await driveToConstructiveForm(page);

  const first = page.getByRole('group', { name: /論点1/ });
  await first.getByLabel('タイトル').fill(ARGUMENTS[0]!.label);
  await first.getByLabel('本文').fill(ARGUMENTS[0]!.body);
  await page.getByRole('button', { name: '立論を提出する' }).click();
  await expect(page.getByRole('heading', { name: '提出済みの本文' })).toBeVisible();

  const urlBeforeReload = page.url();
  await page.reload();

  expect(page.url()).toBe(urlBeforeReload);
  await expect(page.getByText('第1セクション／立論')).toBeVisible();
  await expect(page.getByText('私は論題に賛成します。')).toBeVisible();
  await expect(page.getByRole('table').getByRole('rowheader', { name: 'AD1' })).toBeVisible();
  // 入力欄は戻らない。確定済みだからである
  await expect(page.getByRole('heading', { name: '立論を入力する' })).toHaveCount(0);
});

test('進行位置はサーバが持つ（未来スロットの内容を出さない）', async ({ page }) => {
  await driveToConstructiveForm(page);

  const progress = page.getByRole('list').filter({ hasText: '未着手' });
  await expect(progress).toBeVisible();
  // 進捗に出るのは位置と状態だけで、未来のセクション名は出さない（設計 §18.1）
  await expect(page.getByText('第2セクション')).toHaveCount(0);
});
