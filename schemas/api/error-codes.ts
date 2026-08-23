import { z } from 'zod';

/**
 * API エラーコード（設計 §14.4 の9種）。
 * ここに無いコードを API から返さない。
 */
export const apiErrorCodeSchema = z.enum([
  'INVALID_TRANSITION',
  'MATCH_NOT_FOUND',
  'MATCH_VERSION_CONFLICT',
  'SLOT_NOT_READY',
  'RESULT_NOT_READY',
  'INVALID_HUMAN_OUTPUT',
  'AI_OUTPUT_REJECTED',
  'MATCH_BUDGET_EXCEEDED',
  'AI_PROVIDER_UNAVAILABLE',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
