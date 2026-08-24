import { beforeEach, describe, expect, it } from 'vitest';

import { POST as advanceRoute } from '@/app/api/matches/[id]/advance/route';
import { POST as constructiveRoute } from '@/app/api/matches/[id]/constructive/route';
import { POST as evidenceCardsRoute } from '@/app/api/matches/[id]/evidence-cards/route';
import { GET as getMatchRoute } from '@/app/api/matches/[id]/route';
import { GET as exportRoute } from '@/app/api/matches/[id]/export/route';
import { GET as resultRoute } from '@/app/api/matches/[id]/result/route';
import { POST as skipPrepRoute } from '@/app/api/matches/[id]/skip-prep/route';
import { POST as startRoute } from '@/app/api/matches/[id]/start/route';
import { POST as createMatchRoute } from '@/app/api/matches/route';
import { getMatchRepository, resetMatchRepository } from '@/infrastructure/repositories';
import type { MatchSnapshot } from '@/schemas/api';

/**
 * API ルート（設計 §14）。
 *
 * Route Handler をそのまま呼び、封筒・status・進行の順序を確かめる。
 * ブラウザは使わない（それは E2E の仕事である）。
 */

const MOTION_CODE = 'demo_bukatsu_ja';
const RULE_SET_CODE = 'henda_20th_2025_42_v1';

type Envelope<T> = { ok: true; data: T; requestId: string } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> }; requestId: string };

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function envelopeOf<T>(response: Response): Promise<Envelope<T>> {
  return (await response.json()) as Envelope<T>;
}

async function createMatch(): Promise<MatchSnapshot> {
  const response = await createMatchRoute(
    jsonRequest({
      motionCode: MOTION_CODE,
      ruleSetCode: RULE_SET_CODE,
      playerName: 'テスト太郎',
      difficulty: 'normal',
    }),
  );
  expect(response.status).toBe(201);
  const body = await envelopeOf<MatchSnapshot>(response);
  if (!body.ok) throw new Error(`作成に失敗した: ${body.error.message}`);
  return body.data;
}

/** 立論の入力待ちまで進める（start → advance） */
async function driveToConstructive(): Promise<MatchSnapshot> {
  const created = await createMatch();

  const started = await envelopeOf<MatchSnapshot>(
    await startRoute(jsonRequest({ expectedVersion: created.version }), context(created.id)),
  );
  if (!started.ok) throw new Error(`start に失敗した: ${started.error.message}`);

  const advanced = await envelopeOf<MatchSnapshot>(
    await advanceRoute(
      jsonRequest({ expectedVersion: started.data.version }),
      context(created.id),
    ),
  );
  if (!advanced.ok) throw new Error(`advance に失敗した: ${advanced.error.message}`);
  return advanced.data;
}

const constructiveBody = (snapshot: MatchSnapshot, overrides: Record<string, unknown> = {}) => ({
  expectedVersion: snapshot.version,
  slotIndex: snapshot.currentSlot?.index ?? 0,
  plan: '国が高校の部活動を選択制とする制度を導入する。',
  arguments: [
    { label: '学習時間が増える', body: '現在は…。選択制にすれば…。', evidenceCardIds: [] },
    { label: '教員の負担が減る', body: '教員は…。', evidenceCardIds: [] },
  ],
  ...overrides,
});

beforeEach(() => {
  // Repository はプロセス内で1つ。テストごとに作り直す
  resetMatchRepository();
});

describe('POST /api/matches（設計 §14.3）', () => {
  it('201 で ready の snapshot を返し、seed Evidence を取り込む', async () => {
    const snapshot = await createMatch();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.seats).toHaveLength(8);
    expect(snapshot.seats.find((seat) => seat.seat === 'A1')).toMatchObject({
      occupantType: 'human',
      displayName: 'テスト太郎',
    });
    expect(snapshot.motion.code).toBe(MOTION_CODE);

    const cards = await getMatchRepository().listEvidenceCards(snapshot.id);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.matchId === snapshot.id)).toBe(true);
  });

  it('同梱以外の motion / rule set は拒否する（設計 §4）', async () => {
    const response = await createMatchRoute(
      jsonRequest({
        motionCode: 'unknown_motion',
        ruleSetCode: RULE_SET_CODE,
        playerName: 'テスト太郎',
        difficulty: 'normal',
      }),
    );
    expect(response.status).toBe(422);
  });

  it('表示名が空なら 422（設計 §19）', async () => {
    const response = await createMatchRoute(
      jsonRequest({
        motionCode: MOTION_CODE,
        ruleSetCode: RULE_SET_CODE,
        playerName: '',
        difficulty: 'normal',
      }),
    );
    expect(response.status).toBe(422);
  });

  it('未知キーを拒否する', async () => {
    const response = await createMatchRoute(
      jsonRequest({
        motionCode: MOTION_CODE,
        ruleSetCode: RULE_SET_CODE,
        playerName: 'テスト太郎',
        difficulty: 'normal',
        currentSlotIndex: 5,
      }),
    );
    expect(response.status).toBe(422);
  });
});

describe('GET /api/matches/:id（設計 §14.3）', () => {
  it('保存済みの状態を返す', async () => {
    const created = await createMatch();
    const body = await envelopeOf<MatchSnapshot>(
      await getMatchRoute(new Request('http://localhost/api'), context(created.id)),
    );
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.id).toBe(created.id);
    expect(body.data.version).toBe(created.version);
  });

  it('存在しない id は 404 MATCH_NOT_FOUND', async () => {
    const response = await getMatchRoute(
      new Request('http://localhost/api'),
      context('match_unknown'),
    );
    expect(response.status).toBe(404);
    const body = await envelopeOf<MatchSnapshot>(response);
    expect(body.ok).toBe(false);
    if (body.ok) return;
    expect(body.error.code).toBe('MATCH_NOT_FOUND');
  });
});

describe('進行（設計 §11 / §14.1）', () => {
  it('start → advance で立論の入力待ちになる', async () => {
    const snapshot = await driveToConstructive();
    expect(snapshot.status).toBe('waiting_human');
    expect(snapshot.currentAction).toBe('input_constructive');
    expect(snapshot.currentSlot?.kind).toBe('constructive');
    expect(snapshot.currentSlot?.actorSeat).toBe('A1');
  });

  it('1回の advance で進むのは1ステップだけである（設計 §14.1）', async () => {
    const created = await createMatch();
    const started = await envelopeOf<MatchSnapshot>(
      await startRoute(jsonRequest({ expectedVersion: created.version }), context(created.id)),
    );
    if (!started.ok) return;

    expect(started.data.status).toBe('active');
    const advanced = await envelopeOf<MatchSnapshot>(
      await advanceRoute(
        jsonRequest({ expectedVersion: started.data.version }),
        context(created.id),
      ),
    );
    if (!advanced.ok) return;
    expect(advanced.data.version).toBe(started.data.version + 1);
  });

  it('立論のあとは質疑に入り、人間の回答を待つ（設計 §7）', async () => {
    const waiting = await driveToConstructive();
    const submitted = await envelopeOf<MatchSnapshot>(
      await constructiveRoute(jsonRequest(constructiveBody(waiting)), context(waiting.id)),
    );
    if (!submitted.ok) return;

    // client は snapshot の currentAction に従って進める（設計 §14.1）
    let snapshot = submitted.data;
    for (let step = 0; step < 8; step += 1) {
      if (snapshot.currentAction === 'input_answer') break;

      const route = snapshot.currentAction === 'skip_prep' ? skipPrepRoute : advanceRoute;
      const response = await route(
        jsonRequest({ expectedVersion: snapshot.version }),
        context(waiting.id),
      );
      const body = await envelopeOf<MatchSnapshot>(response);
      if (!body.ok) throw new Error(`進行が止まった: ${body.error.code} ${body.error.message}`);
      snapshot = body.data;
    }

    // 第2セクションはAIが質問し、人間（A1）が答える
    expect(snapshot.currentAction).toBe('input_answer');
    expect(snapshot.currentSlot?.kind).toBe('cx');
    expect(snapshot.cx).toMatchObject({ phase: 'answer', turnCursor: 0 });

    const turns = await getMatchRepository().listCxTurns(waiting.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answerText).toBeNull();
  });

  it('古い expectedVersion の start は 409', async () => {
    const created = await createMatch();
    const response = await startRoute(jsonRequest({ expectedVersion: 999 }), context(created.id));
    expect(response.status).toBe(409);
  });
});

describe('POST /api/matches/:id/constructive（設計 §8 / §14.3）', () => {
  it('採番して保存し、snapshot のフローシートに載る', async () => {
    const waiting = await driveToConstructive();
    const body = await envelopeOf<MatchSnapshot>(
      await constructiveRoute(jsonRequest(constructiveBody(waiting)), context(waiting.id)),
    );

    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.flowSheet.map((row) => row.argumentKey)).toEqual(['AD1', 'AD2']);
    expect(body.data.status).toBe('active');

    const speeches = await getMatchRepository().listSpeeches(waiting.id);
    expect(speeches).toHaveLength(1);
    expect(speeches[0]?.text.startsWith('私は論題に賛成します。')).toBe(true);
  });

  it('二重送信では2件目が 409 になり、speech は1件のままである（E03）', async () => {
    const waiting = await driveToConstructive();
    const first = await constructiveRoute(
      jsonRequest(constructiveBody(waiting)),
      context(waiting.id),
    );
    expect(first.status).toBe(200);

    const second = await constructiveRoute(
      jsonRequest(constructiveBody(waiting)),
      context(waiting.id),
    );
    expect(second.status).toBe(409);

    expect(await getMatchRepository().listSpeeches(waiting.id)).toHaveLength(1);
  });

  it.each([
    { label: 'argumentKey を送る', body: { arguments: [{ label: 'x', body: 'y', argumentKey: 'AD1' }] } },
    { label: 'currentSlotIndex を送る', body: { currentSlotIndex: 3 } },
    { label: '論点0件', body: { arguments: [] } },
  ])('$label と 422 になる（採番と進行位置はサーバが持つ）', async ({ body }) => {
    const waiting = await driveToConstructive();
    const response = await constructiveRoute(
      jsonRequest(constructiveBody(waiting, body)),
      context(waiting.id),
    );
    expect(response.status).toBe(422);
    expect(await getMatchRepository().listArguments(waiting.id)).toEqual([]);
  });
});

describe('POST /api/matches/:id/evidence-cards（設計 §14.3 / §15.6）', () => {
  it('201 で登録し、立論から選べるようになる', async () => {
    const created = await createMatch();
    const before = (await getMatchRepository().listEvidenceCards(created.id)).length;

    const response = await evidenceCardsRoute(
      jsonRequest({
        expectedVersion: created.version,
        side: 'affirmative',
        title: '手入力のカード',
        sourceLabel: '出典',
        publishedOn: '2026-01',
        quote: '引用',
      }),
      context(created.id),
    );
    expect(response.status).toBe(201);

    const cards = await getMatchRepository().listEvidenceCards(created.id);
    expect(cards).toHaveLength(before + 1);
    expect(cards.at(-1)?.verificationStatus).toBe('unverified');
    expect(cards.at(-1)?.demoOnly).toBe(false);
  });

  it('試合が始まった後は登録できない（設計 §5.1）', async () => {
    const waiting = await driveToConstructive();
    const response = await evidenceCardsRoute(
      jsonRequest({
        expectedVersion: waiting.version,
        side: 'affirmative',
        title: '後から追加',
        sourceLabel: '出典',
        publishedOn: '2026-01',
        quote: '引用',
      }),
      context(waiting.id),
    );
    expect(response.status).toBe(400);
  });

  it('古い expectedVersion は 409', async () => {
    const created = await createMatch();
    const response = await evidenceCardsRoute(
      jsonRequest({
        expectedVersion: created.version + 5,
        side: 'affirmative',
        title: 'カード',
        sourceLabel: '出典',
        publishedOn: '2026-01',
        quote: '引用',
      }),
      context(created.id),
    );
    expect(response.status).toBe(409);
  });
});

describe('GET /api/matches/:id/result（設計 §14.3 / §14.4）', () => {
  it('判定前は 409 RESULT_NOT_READY である', async () => {
    const created = await createMatch();
    const response = await resultRoute(new Request('http://localhost/api'), context(created.id));
    expect(response.status).toBe(409);

    const body = await envelopeOf<unknown>(response);
    expect(body.ok).toBe(false);
    if (body.ok) return;
    expect(body.error.code).toBe('RESULT_NOT_READY');
  });

  it('存在しない match は 404 である', async () => {
    const response = await resultRoute(new Request('http://localhost/api'), context('match_none'));
    expect(response.status).toBe(404);
  });
});

describe('GET /api/matches/:id/export（設計 §14.3 / §19）', () => {
  it('判定前でも記録を返し、鍵と prompt を含めない', async () => {
    const created = await createMatch();
    const response = await exportRoute(new Request('http://localhost/api'), context(created.id));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const text = await response.text();
    expect(text).toContain('公式ジャッジではありません');
    expect(text).not.toContain('OPENAI_API_KEY');
    expect(text).not.toContain('systemPrompt');

    const body = JSON.parse(text) as { result: unknown; match: { id: string } };
    expect(body.match.id).toBe(created.id);
    expect(body.result).toBeNull();
  });
});
