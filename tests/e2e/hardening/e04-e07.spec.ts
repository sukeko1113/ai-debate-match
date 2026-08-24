import { expect, test, type Page } from '@playwright/test';

import {
  driveToConstructiveForm,
  exportOf,
  sectionText,
  stepOnce,
  stepUntil,
  submitConstructive,
} from '../support/drive';

/**
 * E04 AI障害 / E06 未知argument_key / E07 意味的New Argument（設計 §21.3）。
 *
 * この project は `MOCK_AI_FIXTURE=hardening` で起動する。同じ1つの fixture が
 * 3つの筋書きを別々のセクションに持つ。
 *
 * - 第5セクション（反論）: 既存keyを名乗りながら独立した主張を混ぜる → E07
 * - 第7セクション（反論）: 未知key `DA9` を3回返してから直る → E06
 * - 第8セクション（質疑）: 未知key を3回返してから直る → E04
 */

const PAUSED_HEADING = 'AIの生成が確定しませんでした';

/** 指定のセクションで停止するまで進める */
async function driveToPauseAt(page: Page, sectionPrefix: string): Promise<void> {
  await driveToConstructiveForm(page);
  await submitConstructive(page);

  const reached = await stepUntil(page, async (target) => {
    if ((await target.getByRole('heading', { name: PAUSED_HEADING }).count()) === 0) return false;
    return (await sectionText(target).innerText()).startsWith(sectionPrefix);
  });
  expect(reached).toBe(true);
}

test.describe('E06 未知argument_key', () => {
  test('E06: 未知keyの反論は棄却され、arguments は4件のまま止まる', async ({ page }) => {
    test.setTimeout(120_000);
    await driveToPauseAt(page, '第7セクション');

    // 3回とも棄却され、確定しないまま止まっている（設計 §15.5）
    await expect(page.getByRole('heading', { name: PAUSED_HEADING })).toBeVisible();

    const matchUrl = page.url();
    const paused = (await exportOf(page.request, matchUrl)) as {
      arguments: ReadonlyArray<{ argumentKey: string }>;
      speeches: ReadonlyArray<{ sectionNo: number }>;
      aiRuns: ReadonlyArray<{ role: string; status: string; errorCode: string | null }>;
    };

    // 論点は増えない。Attack 以降で arguments に行は増えない（設計 §6.3 / §9）
    expect(paused.arguments.map((row) => row.argumentKey).sort()).toEqual([
      'AD1',
      'AD2',
      'DA1',
      'DA2',
    ]);
    // 第7セクションの発話は確定していない
    expect(paused.speeches.filter((speech) => speech.sectionNo === 7)).toHaveLength(0);
    // 棄却の記録が残る（設計 §14.4 AI_OUTPUT_REJECTED）
    const rejected = paused.aiRuns.filter((run) => run.errorCode === 'AI_OUTPUT_REJECTED');
    expect(rejected.length).toBeGreaterThanOrEqual(3);

    // もう一度生成すると、正しいkeyで確定する
    await stepOnce(page);
    const recovered = await stepUntil(
      page,
      async (target) => (await target.getByRole('heading', { name: PAUSED_HEADING }).count()) === 0,
      3,
    );
    expect(recovered).toBe(true);

    const after = (await exportOf(page.request, matchUrl)) as {
      arguments: ReadonlyArray<unknown>;
      speeches: ReadonlyArray<{ sectionNo: number }>;
    };
    expect(after.speeches.filter((speech) => speech.sectionNo === 7)).toHaveLength(1);
    expect(after.arguments).toHaveLength(4);
  });
});

test.describe('E04 AI障害', () => {
  test('E04: 質疑でAIが失敗すると paused になり、Retry で同じ往復から復帰する', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await driveToPauseAt(page, '第8セクション');

    // 往復位置は動かない（設計 §11 RETRY_AI）
    await expect(page.getByText('質疑 1/3（質問）')).toBeVisible();

    const matchUrl = page.url();
    const paused = (await exportOf(page.request, matchUrl)) as {
      cxTurns: ReadonlyArray<{ sectionNo: number }>;
    };
    expect(paused.cxTurns.filter((turn) => turn.sectionNo === 8)).toHaveLength(0);

    // 同じ往復から作り直す
    await stepOnce(page);
    await expect(page.getByRole('heading', { name: PAUSED_HEADING })).toHaveCount(0);
    await expect(page.getByText('質疑 1/3（回答）')).toBeVisible();

    const recovered = (await exportOf(page.request, matchUrl)) as {
      cxTurns: ReadonlyArray<{ sectionNo: number; turnIndex: number }>;
    };
    const section8 = recovered.cxTurns.filter((turn) => turn.sectionNo === 8);
    expect(section8).toHaveLength(1);
    expect(section8[0]?.turnIndex).toBe(0);
  });
});

test.describe('E07 意味的New Argument', () => {
  test('E07: 既存keyを名乗る独立主張が findings に載り、判定材料から除外される', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await driveToConstructiveForm(page);
    await submitConstructive(page);

    const reached = await stepUntil(
      page,
      async (target) => (await target.getByRole('button', { name: '判定を実行する' }).count()) > 0,
      160,
    );
    expect(reached).toBe(true);

    await page.getByRole('button', { name: '判定を実行する' }).click();
    await expect(page).toHaveURL(/\/result$/);

    // 指摘が Result に出る（設計 §9.2）
    await expect(
      page.getByRole('heading', { name: '新しい論点として除外した箇所' }),
    ).toBeVisible();
    await expect(page.getByText('さらに、地域社会との関係が失われるという新しい問題もあります。')).toBeVisible();
    await expect(page.getByText('スピーチ全体は除外していません')).toBeVisible();

    // 除外が勝敗を左右しうるので見直しが要る（設計 §16.3）
    await expect(page.getByRole('heading', { name: '見直しが必要な理由' })).toBeVisible();
    await expect(page.getByText('New Argument として除外した箇所が勝者側にある')).toBeVisible();
  });
});
