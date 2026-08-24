import 'server-only';

import { NextResponse } from 'next/server';

import type { AiLimits } from '@/application/run-slot';
import { getDebateAiProvider } from '@/infrastructure/ai';
import { getServerEnv } from '@/infrastructure/config/env';
import { loadMotion, loadPersona } from '@/infrastructure/content';
import { getMatchRepository } from '@/infrastructure/repositories';
import type { ApiErrorCode } from '@/schemas/api';

/**
 * Route Handler の共通処理（設計 §14.2 / §14.4）。
 *
 * 応答は必ずこの2形式のどちらかで返す。HTTP status は設計 §14.4 の表に従う。
 * ここに無いコードを返さない。
 *
 * `_` で始まるディレクトリは App Router の経路にならない。共有コードの置き場に使う。
 */

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  INVALID_TRANSITION: 400,
  MATCH_NOT_FOUND: 404,
  MATCH_VERSION_CONFLICT: 409,
  SLOT_NOT_READY: 409,
  RESULT_NOT_READY: 409,
  INVALID_HUMAN_OUTPUT: 422,
  AI_OUTPUT_REJECTED: 422,
  MATCH_BUDGET_EXCEEDED: 429,
  AI_PROVIDER_UNAVAILABLE: 503,
};

export function httpStatusFor(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function successResponse<TData>(data: TData, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data, requestId: crypto.randomUUID() }, { status });
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, details }, requestId: crypto.randomUUID() },
    { status: httpStatusFor(code) },
  );
}

/** 本文が JSON でなければ null。呼び出し側が 422 に写す */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * application 層へ渡す実行環境。
 * id と時刻はここで作る。domain と Repository は作らない（設計 §12.1）。
 */
export function serverDeps() {
  return {
    repository: getMatchRepository(),
    newId: (prefix: string): string => `${prefix}_${crypto.randomUUID()}`,
    now: (): string => new Date().toISOString(),
  };
}

/**
 * AI を呼ぶ経路の実行環境（設計 §15 / §22）。
 * 上限も timeout も環境変数から来る。route にも application にも数値を書かない。
 */
export function aiServerDeps() {
  const env = getServerEnv();
  const limits: AiLimits = {
    maxRunsPerMatch: env.MAX_AI_RUNS_PER_MATCH,
    maxAttemptsPerMatch: env.MAX_AI_ATTEMPTS_PER_MATCH,
    maxRetriesPerRun: env.MAX_AI_RETRIES_PER_RUN,
    runTimeoutMs: env.AI_RUN_TIMEOUT_MS,
    maxMatchOutputTokens: env.MAX_MATCH_OUTPUT_TOKENS,
  };

  return {
    ...serverDeps(),
    provider: getDebateAiProvider(),
    personaFor: loadPersona,
    noArgumentCxQuestionsFor,
    limits,
  };
}

/**
 * 論点0件のCXで使う固定質問（設計 §10.1）。
 *
 * 質問文は論題ごとに `content/motions/*.json` にある。AIには作らせない。
 * Phase 1 が扱う論題は同梱の1件だけなので、code が合わなければ読み替えずに投げる。
 */
export function noArgumentCxQuestionsFor(motionCode: string): readonly string[] {
  const motion = loadMotion();
  if (motion.code !== motionCode) {
    throw new Error(
      `同梱の論題以外は Phase 1 では扱わない（要求=${motionCode}, 同梱=${motion.code}）。設計 §10.1`,
    );
  }
  return motion.noArgumentCxQuestions;
}
