import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E の共通操作（設計 §21.3）。
 *
 * **入力値をここに書かない。** 人間の入力は `content/fixtures/e2e-human-input.json` から読む
 * （設計 §15.7）。10回同じ結果になることを見るには、AI出力だけでなく人間入力も固定する必要がある。
 *
 * 進行はサーバが決める。ここがやるのは「画面に出ているボタンを押す」ことだけである。
 */

// Playwright は CommonJS で読み込むため、`import.meta` を使わない
const rootDir = process.cwd();

type HumanInput = {
  readonly playerName: string;
  readonly difficulty: string;
  readonly constructive: {
    readonly plan: string | null;
    readonly arguments: ReadonlyArray<{
      readonly label: string;
      readonly body: string;
      readonly useFirstEvidenceCard: boolean;
    }>;
  };
  readonly cxAnswers: readonly string[];
};

/** 設計 §15.7 の人間入力 fixture。形の検証は schemas 側が行う */
export const humanInput = JSON.parse(
  readFileSync(path.join(rootDir, 'content', 'fixtures', 'e2e-human-input.json'), 'utf8'),
) as HumanInput;

/** 保存状態の version 表示。サーバが1歩進んだことの目印にする */
export function versionText(page: Page) {
  return page.locator('.slot-facts dd').last();
}

/** 試合を作り、Match Room へ入る */
export async function createMatch(page: Page): Promise<string> {
  await page.goto('/matches/new');
  await page.getByLabel('あなたの表示名（肯定側A1）').fill(humanInput.playerName);
  await page.getByRole('button', { name: '試合を作成する' }).click();
  await expect(page).toHaveURL(/\/matches\/match_/);
  return page.url();
}

/** 立論の入力待ちまで進める（start → advance） */
export async function driveToConstructiveForm(page: Page): Promise<string> {
  const url = await createMatch(page);
  await page.getByRole('button', { name: '第1セクションを始める' }).click();
  await page.getByRole('button', { name: '次へ進む' }).click();
  await expect(page.getByRole('heading', { name: '立論を入力する' })).toBeVisible();
  return url;
}

/** fixture の立論をフォームへ入れる。送信はしない */
export async function fillConstructive(page: Page): Promise<void> {
  const { plan, arguments: args } = humanInput.constructive;
  if (plan !== null) {
    const planField = page.getByLabel('プラン（任意）');
    if ((await planField.count()) > 0) await planField.fill(plan);
  }

  for (const [index, argument] of args.entries()) {
    const group = page.getByRole('group', { name: new RegExp(`論点${index + 1}`) });
    if ((await group.count()) === 0) break;
    await group.getByLabel('タイトル').fill(argument.label);
    await group.getByLabel('本文').fill(argument.body);
    if (argument.useFirstEvidenceCard) {
      const card = group.getByRole('checkbox').first();
      if ((await card.count()) > 0) await card.check();
    }
  }
}

/** 立論を提出し、確定するまで待つ */
export async function submitConstructive(page: Page): Promise<void> {
  await fillConstructive(page);
  await page.getByRole('button', { name: '立論を提出する' }).click();
  await expect(page.getByRole('heading', { name: '提出済みの本文' })).toBeVisible();
}

/**
 * 画面に出ている操作を1つだけ行う。何も無ければ false。
 *
 * 押す順序は決めない。**サーバが次にできることを1つだけ出す**ので、出ているものを押す。
 */
export async function stepOnce(page: Page, cxTurn = 0): Promise<boolean> {
  const answerForm = page.getByRole('heading', { name: /質疑に答える/ });
  if ((await answerForm.count()) > 0) {
    const answers = humanInput.cxAnswers;
    const answer = answers[Math.min(cxTurn, answers.length - 1)] ?? answers[0] ?? '回答します。';
    const version = versionText(page);
    const before = await version.innerText();
    await page.getByLabel('あなたの回答').fill(answer);
    await page.getByRole('button', { name: '回答を送る' }).click();
    await expect(version).not.toHaveText(before);
    return true;
  }

  for (const label of ['次へ進む', '準備を終える', 'もう一度生成する']) {
    const button = page.getByRole('button', { name: label });
    if ((await button.count()) === 0) continue;

    const version = versionText(page);
    const before = await version.innerText();
    try {
      await button.click({ timeout: 5_000 });
    } catch {
      // 直前の更新でボタンが差し替わることがある。画面を読み直して次の周回へ回す
      return true;
    }

    // 進むか、エラーが出るかのどちらかである。AIの生成が確定しなかったときは
    // version が動かないまま paused の画面へ変わる（設計 §11 / §15.5）
    await expect(async () => {
      const changed = (await version.innerText()) !== before;
      // 画面上部の見出し帯ではなく、操作のエラー表示だけを見る（設計 §18.1）
      const failed = (await page.locator('p.error[role="alert"]').count()) > 0;
      expect(changed || failed).toBe(true);
    }).toPass({ timeout: 15_000 });
    return true;
  }
  return false;
}

/** 目印が出るまで1歩ずつ進める。出なければ false */
export async function stepUntil(
  page: Page,
  isDone: (page: Page) => Promise<boolean>,
  maxSteps = 120,
): Promise<boolean> {
  let cxTurn = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    if (await isDone(page)) return true;
    const answering = (await page.getByRole('heading', { name: /質疑に答える/ }).count()) > 0;
    if (!(await stepOnce(page, cxTurn))) return await isDone(page);
    if (answering) cxTurn += 1;
  }
  return await isDone(page);
}

/** 判定ボタンが出るまで進める（立論の提出を含む） */
export async function driveToJudge(page: Page): Promise<string> {
  const url = await driveToConstructiveForm(page);
  await submitConstructive(page);

  const reached = await stepUntil(
    page,
    async (target) => (await target.getByRole('button', { name: '判定を実行する' }).count()) > 0,
  );
  expect(reached).toBe(true);
  return url;
}

/** 現在のセクション見出し（例: 第2セクション／質疑） */
export function sectionText(page: Page) {
  return page.locator('.slot-facts dd').first();
}

/** 試合の記録（設計 §14.3 export）。API を直接読む */
export async function exportOf(
  request: APIRequestContext,
  matchUrl: string,
): Promise<Record<string, unknown>> {
  const matchId = matchUrl.split('/matches/')[1]?.split('/')[0] ?? '';
  const response = await request.get(`/api/matches/${matchId}/export`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** snapshot（設計 付録B）。API を直接読む */
export async function snapshotOf(
  request: APIRequestContext,
  matchUrl: string,
): Promise<Record<string, unknown>> {
  const matchId = matchUrl.split('/matches/')[1]?.split('/')[0] ?? '';
  const response = await request.get(`/api/matches/${matchId}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { data: Record<string, unknown> };
  return body.data;
}

/**
 * API から試合を進める（設計 §14.3）。
 *
 * 画面を1回も開かずに完走させたいときに使う。10回まわす決定性の確認（E09）と、
 * 人間が一度も入力しない筋書き（E11）がこれを使う。
 * **進める判断はしない。** snapshot の `currentAction` に出ているものを1つだけ行う。
 */
export type ApiHumanTurn = (params: {
  readonly request: APIRequestContext;
  readonly matchId: string;
  readonly snapshot: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

async function postJson(
  request: APIRequestContext,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request.post(url, { data: body });
  return {
    status: response.status(),
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** 成功した応答から snapshot を取り出す。失敗ならそのまま投げる */
function dataOf(result: { status: number; body: Record<string, unknown> }): Record<string, unknown> {
  if (result.body.ok !== true) {
    throw new Error(`API が失敗した（${result.status}）: ${JSON.stringify(result.body)}`);
  }
  return result.body.data as Record<string, unknown>;
}

export async function createMatchByApi(
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const created = dataOf(
    await postJson(request, '/api/matches', {
      motionCode: 'demo_bukatsu_ja',
      ruleSetCode: 'henda_20th_2025_42_v1',
      playerName: humanInput.playerName,
      difficulty: humanInput.difficulty,
    }),
  );
  return dataOf(
    await postJson(request, `/api/matches/${String(created.id)}/start`, {
      expectedVersion: created.version,
    }),
  );
}

/** 立論と質疑の回答を fixture のとおりに出す（E09 が使う） */
export const submitFixtureInput: ApiHumanTurn = async ({ request, matchId, snapshot }) => {
  const version = snapshot.version;
  const slotIndex = (snapshot.currentSlot as { index: number } | null)?.index ?? 0;

  if (snapshot.currentAction === 'input_constructive') {
    // Evidence の id は match ごとに違う。記録から1枚目を引く（fixture に id を書かない）
    const evidence = await request.get(`/api/matches/${matchId}/export`);
    const exported = (await evidence.json()) as {
      evidenceCards: ReadonlyArray<{ id: string; side: string }>;
    };
    const first = exported.evidenceCards.find((card) => card.side === 'affirmative');

    return dataOf(
      await postJson(request, `/api/matches/${matchId}/constructive`, {
        expectedVersion: version,
        slotIndex,
        plan: humanInput.constructive.plan,
        arguments: humanInput.constructive.arguments.map((argument) => ({
          label: argument.label,
          body: argument.body,
          evidenceCardIds:
            argument.useFirstEvidenceCard && first !== undefined ? [first.id] : [],
        })),
      }),
    );
  }

  const cx = snapshot.cx as { turnCursor: number } | null;
  const cursor = cx?.turnCursor ?? 0;
  const answers = humanInput.cxAnswers;
  return dataOf(
    await postJson(request, `/api/matches/${matchId}/cx-answer`, {
      expectedVersion: version,
      slotIndex,
      cxTurnIndex: cursor,
      text: answers[Math.min(cursor, answers.length - 1)] ?? '回答します。',
      evidenceCardIds: [],
    }),
  );
};

/** 人間の手番を時間切れで終える（設計 §11 HUMAN_TIMEOUT。manual のみ） */
export const timeoutHumanTurn: ApiHumanTurn = async ({ request, matchId, snapshot }) =>
  dataOf(
    await postJson(request, `/api/matches/${matchId}/timeout`, {
      expectedVersion: snapshot.version,
    }),
  );

/** completed になるまで API で進める */
export async function runMatchByApi(
  request: APIRequestContext,
  onHumanTurn: ApiHumanTurn,
): Promise<Record<string, unknown>> {
  let snapshot = await createMatchByApi(request);
  const matchId = String(snapshot.id);

  for (let step = 0; step < 200; step += 1) {
    if (snapshot.status === 'completed') return snapshot;

    const action = snapshot.currentAction;
    if (action === 'input_constructive' || action === 'input_answer') {
      snapshot = await onHumanTurn({ request, matchId, snapshot });
      continue;
    }
    if (action === 'skip_prep') {
      snapshot = dataOf(
        await postJson(request, `/api/matches/${matchId}/skip-prep`, {
          expectedVersion: snapshot.version,
        }),
      );
      continue;
    }
    if (snapshot.status === 'paused') {
      snapshot = dataOf(
        await postJson(request, `/api/matches/${matchId}/retry-ai`, {
          expectedVersion: snapshot.version,
        }),
      );
      continue;
    }
    snapshot = dataOf(
      await postJson(request, `/api/matches/${matchId}/advance`, {
        expectedVersion: snapshot.version,
      }),
    );
  }
  throw new Error('200ステップで完走しなかった');
}

/** 判定まで行う。返すのは判定結果である */
export async function judgeByApi(
  request: APIRequestContext,
  snapshot: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = dataOf(
    await postJson(request, `/api/matches/${String(snapshot.id)}/judge`, {
      expectedVersion: snapshot.version,
    }),
  );
  return result.result as Record<string, unknown>;
}
