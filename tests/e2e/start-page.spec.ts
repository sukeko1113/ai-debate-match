import { expect, test } from '@playwright/test';

/**
 * P1 の E2E は「トップ画面が表示される」ことだけを見る。
 * 受入シナリオ E01〜E12（設計 §21.3）は P11 で追加する。
 */
test('OPENAI_API_KEY が無くてもトップ画面が表示される', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'AI英語ディベート練習' })).toBeVisible();
  await expect(page.getByRole('button', { name: '試合を始める' })).toBeVisible();
  await expect(page.getByText('公式ジャッジではありません')).toBeVisible();
});
