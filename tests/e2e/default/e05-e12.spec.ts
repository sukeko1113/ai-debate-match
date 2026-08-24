import { expect, test } from '@playwright/test';

import {
  createMatch,
  driveToConstructiveForm,
  exportOf,
  humanInput,
  runMatchByApi,
  judgeByApi,
  sectionText,
  snapshotOf,
  stepOnce,
  submitConstructive,
  submitFixtureInput,
} from '../support/drive';

/**
 * E05 禁止Evidence / E09 決定性 / E10 prep / E12 同期advance（設計 §21.3）。
 */

test.describe('E05 禁止Evidence', () => {
  test('E05: 未知の Evidence ID を混ぜた立論は 422 で、確定も保存もされない', async ({ page }) => {
    const matchUrl = await driveToConstructiveForm(page);
    const matchId = matchUrl.split('/matches/')[1] ?? '';
    const snapshot = await snapshotOf(page.request, matchUrl);

    // 画面からは選べない値を、API へ直接送る（設計 §15.6 の ID guard）
    const response = await page.request.post(`/api/matches/${matchId}/constructive`, {
      data: {
        expectedVersion: snapshot.version,
        slotIndex: (snapshot.currentSlot as { index: number }).index,
        plan: humanInput.constructive.plan,
        arguments: [
          {
            label: humanInput.constructive.arguments[0]?.label ?? '論点',
            body: humanInput.constructive.arguments[0]?.body ?? '本文',
            evidenceCardIds: ['evidence_card_not_in_this_match'],
          },
        ],
      },
    });
    expect(response.status()).toBe(422);

    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_HUMAN_OUTPUT');

    // 1行も保存されていない（設計 §11: 状態機械を先に引き、通らなければ書かない）
    const exported = (await exportOf(page.request, matchUrl)) as {
      speeches: ReadonlyArray<unknown>;
      arguments: ReadonlyArray<unknown>;
      evidenceUses: ReadonlyArray<unknown>;
    };
    expect(exported.speeches).toHaveLength(0);
    expect(exported.arguments).toHaveLength(0);
    expect(exported.evidenceUses).toHaveLength(0);

    // 画面はまだ入力待ちのままである
    await page.reload();
    await expect(page.getByRole('heading', { name: '立論を入力する' })).toBeVisible();
  });
});

test.describe('E09 決定性', () => {
  /** 毎回変わってよいもの（id と時刻）を落として比べる */
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== 'object') return value;

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (key === 'id' || key === 'matchId' || key === 'speechId' || key === 'cxTurnId') continue;
      if (key === 'evidenceCardId' || key === 'evidenceCardIds') continue;
      if (key === 'createdAt' || key === 'version') continue;
      result[key] = normalize(entry);
    }
    return result;
  }

  test('E09: 同じ fixture で10回まわし、10回とも完走して結果が一致する', async ({ request }) => {
    test.setTimeout(300_000);
    const runs: string[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const completed = await runMatchByApi(request, submitFixtureInput);
      expect(completed.status).toBe('completed');

      const result = await judgeByApi(request, completed);
      const exported = (await exportOf(
        request,
        `/matches/${String(completed.id)}`,
      )) as Record<string, unknown>;

      runs.push(
        JSON.stringify({
          result: normalize(result),
          speeches: normalize(exported.speeches),
          cxTurns: normalize(exported.cxTurns),
          argumentKeys: (exported.arguments as ReadonlyArray<{ argumentKey: string }>).map(
            (row) => row.argumentKey,
          ),
          aiRuns: (exported.aiRuns as ReadonlyArray<unknown>).length,
        }),
      );
    }

    expect(runs).toHaveLength(10);
    for (const [index, run] of runs.entries()) {
      expect(run, `${index + 1}回目が1回目と違う`).toBe(runs[0]);
    }
  });
});

test.describe('E10 prep', () => {
  test('E10: manual では準備スロットが自動進行せず、明示の操作で進む（設計 §6.4）', async ({
    page,
  }) => {
    await driveToConstructiveForm(page);
    await submitConstructive(page);

    // 立論スロットを閉じると準備スロットへ入る
    await stepOnce(page);
    await expect(sectionText(page)).toHaveText('準備スロット／準備');
    await stepOnce(page);

    const skip = page.getByRole('button', { name: '準備を終える' });
    await expect(skip).toBeVisible();

    // 待っても勝手に進まない。時計はサーバにも client にも無い（CLOCK_MODE=manual）
    const before = await sectionText(page).innerText();
    await page.waitForTimeout(2000);
    await page.reload();
    await expect(sectionText(page)).toHaveText(before);
    await expect(page.getByRole('button', { name: '準備を終える' })).toBeVisible();

    // 明示の操作でだけ進む（設計 §11 SKIP_PREP）
    await page.getByRole('button', { name: '準備を終える' }).click();
    await expect(page.getByRole('button', { name: '準備を終える' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '次へ進む' })).toBeVisible();

    await stepOnce(page);
    await expect(sectionText(page)).toHaveText('第2セクション／質疑');
  });
});

test.describe('E12 同期advance', () => {
  test('E12: advance 1回で ai_runs は最大1件しか増えず、200 が返る（202 は返らない）', async ({
    page,
  }) => {
    const matchUrl = await createMatch(page);
    const matchId = matchUrl.split('/matches/')[1] ?? '';

    let snapshot = await snapshotOf(page.request, matchUrl);
    const started = await page.request.post(`/api/matches/${matchId}/start`, {
      data: { expectedVersion: snapshot.version },
    });
    expect(started.status()).toBe(200);
    snapshot = ((await started.json()) as { data: Record<string, unknown> }).data;

    // AIが担当するスロットへ着くまで進め、そのたびに ai_runs の増分を数える
    for (let step = 0; step < 40; step += 1) {
      const before = (
        (await exportOf(page.request, matchUrl)) as { aiRuns: ReadonlyArray<unknown> }
      ).aiRuns.length;

      const action = snapshot.currentAction;
      if (action === 'input_constructive' || action === 'input_answer') {
        snapshot = await submitFixtureInput({ request: page.request, matchId, snapshot });
        continue;
      }

      const path = action === 'skip_prep' ? 'skip-prep' : 'advance';
      const response = await page.request.post(`/api/matches/${matchId}/${path}`, {
        data: { expectedVersion: snapshot.version },
      });

      // 同期で返す。202 は返さない（設計 §14.1）
      expect(response.status()).toBe(200);
      snapshot = ((await response.json()) as { data: Record<string, unknown> }).data;

      const after = (
        (await exportOf(page.request, matchUrl)) as { aiRuns: ReadonlyArray<unknown> }
      ).aiRuns.length;
      expect(after - before).toBeLessThanOrEqual(1);

      // AIの生成を1回見届けたら十分である
      if (after > before) return;
    }
    throw new Error('AIが担当するスロットへ着かなかった');
  });
});
