import 'server-only';

import { z } from 'zod';

import {
  AiProviderError,
  PROMPT_VERSION,
  type AiGenerateRequest,
  type AiGenerateResult,
  type DebateAiProvider,
  type UsageSnapshot,
} from '../provider';

/**
 * OpenAI Text Provider（設計 §15.1 / §15.5 / §19 / §22）。
 *
 * **契約は Mock と同じ**である。呼び出し側（`application/run-slot/generation.ts`）は
 * どちらの実装かを知らない。
 *
 * ここがやるのは3つだけである。
 * 1. 1回だけ外部を呼ぶ（**再試行しない**。再生成の回数は設計 §15.5 が決め、generation.ts が数える）
 * 2. 返った JSON を**必ず渡された schema で検証する**（設計 §15.1。schema を迂回しない）
 * 3. 失敗を `schema` / `timeout` / `unavailable` の3種類に分ける（設計 §15.5）
 *
 * 鍵は呼び出し元（`infrastructure/ai/index.ts`）が env から読んで渡す。ここで `process.env` を
 * 読まない。鍵は例外にもログにも出さない（設計 §19）。
 */

/** 差し替えられる形にしておく。テストは外部を呼ばない（設計 §21） */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAiProviderOptions = {
  readonly apiKey: string;
  /** `OPENAI_TEXT_MODEL` から来る。コードにモデル名を書かない（設計 §15.5） */
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
};

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** usage の項目名は API の版で違う。両方を読む（設計 §17 の集計に使う） */
const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  })
  .partial()
  .nullish();

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }).nullish(),
      }),
    )
    .min(1),
  usage: usageSchema,
});

/** 応答に usage が無いときの目安。0 を入れて上限を素通りさせない（設計 §17） */
function estimatedUsage(raw: string): UsageSnapshot {
  const outputTokens = Math.ceil(raw.length / 4);
  return { inputTokens: 0, outputTokens, totalTokens: outputTokens, estimated: true };
}

function usageOf(
  usage: z.infer<typeof usageSchema>,
  raw: string,
): UsageSnapshot {
  if (usage === null || usage === undefined) return estimatedUsage(raw);

  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  if (inputTokens === undefined && outputTokens === undefined) return estimatedUsage(raw);

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
  };
}

/**
 * 応答本文から、外へ出してよい範囲の理由だけを取り出す。
 * request body も鍵も含めない（設計 §19）。
 */
function failureReason(status: number, body: string): string {
  const trimmed = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    const message = parsed.error?.message;
    const code = parsed.error?.code;
    if (typeof message === 'string') {
      return `${status} ${typeof code === 'string' ? `${code}: ` : ''}${message.slice(0, 200)}`;
    }
  } catch {
    // JSON でなければ本文の先頭だけを使う
  }
  return `${status} ${trimmed}`;
}

export class OpenAiDebateProvider implements DebateAiProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAiProviderOptions) {
    if (options.apiKey === '') {
      throw new Error('OPENAI_API_KEY が空である。実 Provider は鍵なしで作らない（設計 §22）。');
    }
    if (options.model === '') {
      throw new Error('OPENAI_TEXT_MODEL が空である。モデル名はコードに書かない（設計 §15.5）。');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async generate<T>(request: AiGenerateRequest<T>): Promise<AiGenerateResult<T>> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'system', content: this.schemaHint(request.schema) },
        { role: 'user', content: JSON.stringify(request.input) },
      ],
      // 構造化出力。中身の検証は渡された schema で行う（設計 §15.1）
      response_format: { type: 'json_object' },
      max_completion_tokens: request.maxOutputTokens,
    };

    const controller = new AbortController();
    // 待ち方はここで決めない。timeoutMs は呼び出し側から来る（設計 §22 AI_RUN_TIMEOUT_MS）
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // 同じ位置の同じ試行は同じ呼び出しである（設計 §15.1 / §13.1）
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // AbortError かどうかで timeout と接続失敗を分ける（設計 §15.5）
      const aborted = controller.signal.aborted;
      throw new AiProviderError(
        aborted ? 'timeout' : 'unavailable',
        aborted
          ? `${request.timeoutMs}ms 以内に応答が無かった（設計 §15.5）。`
          : 'AI Provider へ接続できなかった（設計 §15.5）。',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 認証・レート制限・障害はいずれも再試行しない（設計 §15.5 実Provider の行）
      throw new AiProviderError(
        'unavailable',
        `AI Provider が応答を返さなかった: ${failureReason(response.status, await this.safeText(response))}`,
      );
    }

    const payload = chatResponseSchema.safeParse(await response.json().catch(() => null));
    if (!payload.success) {
      throw new AiProviderError('unavailable', 'AI Provider の応答の形が契約と違う（設計 §15.1）。');
    }

    const choice = payload.data.choices[0];
    const raw = choice?.message?.content ?? '';
    if (raw === '') {
      throw new AiProviderError('schema', 'AIの出力が空である（設計 §15.5）。', {
        issues: ['出力が空である。JSON を返すこと'],
        raw: null,
      });
    }
    const truncated = choice?.finish_reason === 'length';

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      throw new AiProviderError('schema', 'AIの出力が JSON として読めない（設計 §15.5）。', {
        issues: truncated
          ? ['出力が上限で打ち切られた。より短い JSON を返すこと']
          : ['JSON として読めない。JSON だけを返すこと'],
        raw,
      });
    }

    const parsed = request.schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AiProviderError('schema', 'AIの出力が schema と競技制約に合わない（設計 §15.5）。', {
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
        raw,
      });
    }

    return { parsed: parsed.data, raw, usage: usageOf(payload.data.usage, raw) };
  }

  /**
   * 期待する JSON の形を伝える（設計 §15.2「出力は指定されたJSON schemaだけに従ってください」）。
   *
   * 変換できない schema（`refine` など）があるため、失敗しても止めない。
   * **形が伝わらなくても検証は Zod 側で必ず行う**ので、ここは補助にすぎない。
   */
  private schemaHint(schema: AiGenerateRequest<unknown>['schema']): string {
    try {
      const jsonSchema = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' });
      return `出力の JSON schema:\n${JSON.stringify(jsonSchema)}`;
    } catch {
      return '出力は JSON オブジェクトだけを返してください。';
    }
  }

  /** 本文が読めなくても、status だけは失敗理由に残す */
  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}

export function createOpenAiDebateProvider(options: OpenAiProviderOptions): DebateAiProvider {
  return new OpenAiDebateProvider(options);
}
