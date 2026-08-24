import { expect, test, type Page } from '@playwright/test';

/**
 * 第2セクションの質疑（設計 §7 / §21.3 E03）。
 *
 * 第2セクションは N4 が質問し、A1（人間）が回答する。
 * 往復位置はサーバが持つ。画面は `質疑 n/3` を表示するだけで、
 * 次にどこへ進むかを決めない（CLAUDE.md 禁止事項）。
 *
 * AI Provider は mock である（`AI_PROVIDER=mock`）。
 */

const PLAYER_NAME = 'テスト太郎';
const ARGUMENT = {
  label: '学習時間が増える',
  body: '現在は部活動が長時間に及ぶ。選択制にすれば学習時間が増える。',
};

/** 立論を出し、第2セクションの回答待ちまで進める */
async function driveToFirstAnswer(page: Page) {
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

  // 立論スロットを閉じ、準備スロットを抜ける
  await stepForward(page);
  await stepForward(page);
  await page.getByRole('button', { name: '準備を終える' }).click();

  await advanceToAnswerForm(page);
  await expect(page.getByText('第2セクション／質疑')).toBeVisible();
}

/** 保存状態の version 表示。サーバが1歩進んだことの目印にする */
function versionText(page: Page) {
  return page.locator('.slot-facts dd').last();
}

/** 1歩だけ進める。version が変わるまで待つ（画面の更新待ちを推測しない） */
async function stepForward(page: Page) {
  const version = versionText(page);
  const before = await version.innerText();
  await page.getByRole('button', { name: '次へ進む' }).click();
  await expect(version).not.toHaveText(before);
}

/** AIの質問1件を出させ、回答フォームが出るまで進める */
async function advanceToAnswerForm(page: Page) {
  const form = page.getByRole('heading', { name: /質疑に答える/ });
  const next = page.getByRole('button', { name: '次へ進む' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 回答フォームか「次へ進む」のどちらかが必ず出る。出るまで待つ
    await expect(form.or(next)).toBeVisible();
    if ((await form.count()) > 0) return;
    await stepForward(page);
  }
  await expect(form).toBeVisible();
}

/** いまの往復に回答する */
async function answer(page: Page, text: string) {
  const version = versionText(page);
  const before = await version.innerText();
  await page.getByLabel('あなたの回答').fill(text);
  await page.getByRole('button', { name: '回答を送る' }).click();
  await expect(version).not.toHaveText(before);
}

test('E03: 第2セクションで人間が3回回答し、cursor が 0→1→2 と進んで完了する', async ({ page }) => {
  await driveToFirstAnswer(page);

  // 往復数は rule set の cxExchangesPerSection から出る（画面は 3 を持たない）
  await expect(page.getByRole('heading', { name: '質疑に答える（質問 1/3）' })).toBeVisible();
  await expect(page.getByText('質疑 1/3（回答）')).toBeVisible();

  await answer(page, '結論から申し上げます。学習時間は増えます。');
  await advanceToAnswerForm(page);
  await expect(page.getByRole('heading', { name: '質疑に答える（質問 2/3）' })).toBeVisible();

  await answer(page, '結論から申し上げます。部活動をしない生徒にも当てはまります。');
  await advanceToAnswerForm(page);
  await expect(page.getByRole('heading', { name: '質疑に答える（質問 3/3）' })).toBeVisible();

  await answer(page, '結論から申し上げます。制度の対象は全校生徒です。');

  // 3往復で質疑は終わる。確定した往復は読み取り専用で残る（設計 §18.1）
  await expect(page.getByRole('heading', { name: /質疑に答える/ })).toHaveCount(0);
  const turns = page.locator('.cx-turns > li');
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(2).locator('.cx-answer')).toHaveText(
    '結論から申し上げます。制度の対象は全校生徒です。',
  );
});

test('E03: 往復の途中で再読込しても、同じスロット・同じ cursor・同じ phase へ戻る', async ({
  page,
}) => {
  await driveToFirstAnswer(page);
  await answer(page, '結論から申し上げます。学習時間は増えます。');
  await advanceToAnswerForm(page);

  await expect(page.getByText('質疑 2/3（回答）')).toBeVisible();
  const questionBeforeReload = await page.locator('form blockquote.cx-question').innerText();
  const urlBeforeReload = page.url();

  await page.reload();

  expect(page.url()).toBe(urlBeforeReload);
  await expect(page.getByText('第2セクション／質疑')).toBeVisible();
  await expect(page.getByText('質疑 2/3（回答）')).toBeVisible();
  await expect(page.getByRole('heading', { name: '質疑に答える（質問 2/3）' })).toBeVisible();
  await expect(page.locator('form blockquote.cx-question')).toHaveText(questionBeforeReload);
  // 確定済みの1往復目は残り、入力欄には戻らない
  await expect(page.locator('.cx-turns > li')).toHaveCount(2);
  await expect(page.locator('.cx-turns > li').first().locator('.cx-answer')).toHaveText(
    '結論から申し上げます。学習時間は増えます。',
  );
});
