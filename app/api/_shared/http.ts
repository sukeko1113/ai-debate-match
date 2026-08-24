import 'server-only';

import { NextResponse } from 'next/server';

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
