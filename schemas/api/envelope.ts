import { z } from 'zod';

import { apiErrorCodeSchema } from './error-codes';

/**
 * API 共通レスポンス形式（設計 §14.2）。
 * すべての Route Handler はこの2形式のいずれかで返す。
 */

/** error 側は data を持たない。details は任意の付随情報 */
export const apiErrorBodySchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const apiErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: apiErrorBodySchema,
  requestId: z.uuid(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** success 側は data の中身をエンドポイントごとに与える */
export function apiSuccessResponseSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
    requestId: z.uuid(),
  });
}

export type ApiSuccessResponse<TData> = {
  ok: true;
  data: TData;
  requestId: string;
};

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;
