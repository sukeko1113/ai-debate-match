import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isAiProviderError, type AiGenerateRequest } from '@/infrastructure/ai/provider';
import { createOpenAiDebateProvider, type FetchLike } from '@/infrastructure/ai/openai-provider';

/**
 * OpenAI Text Provider（設計 §15.1 / §15.5 / §17 / §19）。
 *
 * **外部を呼ばない。** `fetch` を差し替えて、契約どおりに振る舞うかだけを見る。
 * 見るのは3つである。schema を迂回しないこと、失敗を3種類に分けること、
 * 鍵を外へ出さないこと。
 */

const API_KEY = 'sk-test-DO-NOT-USE';
const MODEL = 'test-model';

const outputSchema = z.strictObject({
  speechText: z.string().min(1),
  count: z.number().int(),
});

type Output = z.infer<typeof outputSchema>;

function request(overrides: Partial<AiGenerateRequest<Output>> = {}): AiGenerateRequest<Output> {
  return {
    role: 'attack',
    schema: outputSchema,
    systemPrompt: 'あなたは試合参加者です。',
    input: { sectionNo: 5, ownArguments: [] },
    maxOutputTokens: 1000,
    timeoutMs: 50,
    idempotencyKey: 'match_1:7:-1:attack:1',
    ...overrides,
  };
}

/** OpenAI の応答の形に合わせた最小の作り物 */
function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function chatBody(content: unknown, usage?: unknown) {
  return {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function providerWith(fetchImpl: FetchLike) {
  return createOpenAiDebateProvider({ apiKey: API_KEY, model: MODEL, fetchImpl });
}

describe('正常系（設計 §15.1）', () => {
  it('schema を通った出力だけを返す', async () => {
    const provider = providerWith(async () =>
      jsonResponse(
        chatBody(
          { speechText: '反論します。', count: 1 },
          { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        ),
      ),
    );

    const result = await provider.generate(request());
    expect(result.parsed).toEqual({ speechText: '反論します。', count: 1 });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe(MODEL);
  });

  it('モデル名は渡された値を使う。コードに書かれた名前を使わない（設計 §15.5）', async () => {
    let sentModel: unknown = null;
    const provider = createOpenAiDebateProvider({
      apiKey: API_KEY,
      model: 'another-model',
      fetchImpl: async (_url, init) => {
        sentModel = (JSON.parse(String(init.body)) as { model: unknown }).model;
        return jsonResponse(chatBody({ speechText: 'text', count: 0 }));
      },
    });

    await provider.generate(request());
    expect(sentModel).toBe('another-model');
  });

  it('idempotencyKey を送る（設計 §15.1 / §13.1）', async () => {
    let headers: Record<string, string> = {};
    const provider = providerWith(async (_url, init) => {
      headers = init.headers as Record<string, string>;
      return jsonResponse(chatBody({ speechText: 'text', count: 0 }));
    });

    await provider.generate(request({ idempotencyKey: 'match_9:12:2:cx_answer:2' }));
    expect(headers['idempotency-key']).toBe('match_9:12:2:cx_answer:2');
  });

  it('1回の generate で外部呼び出しは1回だけである（再試行しない・設計 §15.5）', async () => {
    let calls = 0;
    const provider = providerWith(async () => {
      calls += 1;
      return jsonResponse(chatBody({ speechText: 'text', count: 0 }));
    });

    await provider.generate(request());
    expect(calls).toBe(1);
  });

  it('usage が無ければ推定して返す。0 で上限を素通りさせない（設計 §17）', async () => {
    const provider = providerWith(async () =>
      jsonResponse(chatBody({ speechText: 'あ'.repeat(40), count: 0 })),
    );

    const result = await provider.generate(request());
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.estimated).toBe(true);
  });
});

describe('失敗の分類（設計 §15.5）', () => {
  it('schema に合わない出力は kind=schema。違反一覧が付く', async () => {
    const provider = providerWith(async () =>
      jsonResponse(chatBody({ speechText: '', count: 'いち' })),
    );

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('schema');
      expect(error.issues.length).toBeGreaterThan(0);
      expect(error.raw).not.toBeNull();
      return true;
    });
  });

  it('JSON として読めない出力も kind=schema', async () => {
    const provider = providerWith(async () =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{壊れた' } }] }),
    );

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('schema');
      return true;
    });
  });

  it('上限で打ち切られた出力は、短く返すよう修復指示を付ける', async () => {
    const provider = providerWith(async () =>
      jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '{"speechText"' } }] }),
    );

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('schema');
      expect(error.issues.join()).toContain('打ち切られた');
      return true;
    });
  });

  it('応答が空なら kind=schema', async () => {
    const provider = providerWith(async () =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
    );

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('schema');
      return true;
    });
  });

  it.each([
    ['認証エラー', 401],
    ['レート制限', 429],
    ['サーバ障害', 500],
  ])('%s（%i）は kind=unavailable。再試行しない', async (_label, status) => {
    let calls = 0;
    const provider = providerWith(async () => {
      calls += 1;
      return jsonResponse({ error: { message: '失敗した', code: 'some_code' } }, { status });
    });

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('unavailable');
      return true;
    });
    expect(calls).toBe(1);
  });

  it('timeoutMs で切れ、kind=timeout になる（設計 §15.5 / §22）', async () => {
    const provider = providerWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const started = Date.now();
    await expect(provider.generate(request({ timeoutMs: 30 }))).rejects.toSatisfy(
      (error: unknown) => {
        if (!isAiProviderError(error)) return false;
        expect(error.kind).toBe('timeout');
        return true;
      },
    );
    // 呼び出し側の timeoutMs で切れている（Provider が待ち直していない）
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('接続できないときは kind=unavailable', async () => {
    const provider = providerWith(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('unavailable');
      return true;
    });
  });

  it('応答の形が契約と違うときは kind=unavailable', async () => {
    const provider = providerWith(async () => jsonResponse({ choices: [] }));

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.kind).toBe('unavailable');
      return true;
    });
  });
});

describe('秘密情報（設計 §19）', () => {
  it('鍵は Authorization ヘッダにだけ載り、本文には入らない', async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const provider = providerWith(async (_url, init) => {
      seen = {
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return jsonResponse(chatBody({ speechText: 'text', count: 0 }));
    });

    await provider.generate(request());
    expect(seen).not.toBeNull();
    if (seen === null) return;
    const sent = seen as { headers: Record<string, string>; body: string };
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sent.body).not.toContain(API_KEY);
  });

  it('失敗の message に鍵も request body も出さない', async () => {
    const provider = providerWith(async () =>
      jsonResponse({ error: { message: '拒否した' } }, { status: 401 }),
    );

    await expect(provider.generate(request())).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain('あなたは試合参加者です');
      return true;
    });
  });

  it('鍵とモデル名が空なら作れない（設計 §22）', () => {
    expect(() => createOpenAiDebateProvider({ apiKey: '', model: MODEL })).toThrow();
    expect(() => createOpenAiDebateProvider({ apiKey: API_KEY, model: '' })).toThrow();
  });
});
