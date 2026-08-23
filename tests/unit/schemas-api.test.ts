import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  apiSuccessResponseSchema,
} from '@/schemas/api';

const REQUEST_ID = '2b1f2f6e-5f2e-4a1a-9a1e-7b2c9d3e4f50';

describe('API 共通レスポンス形式（設計 §14.2）', () => {
  it('success 形式を受理する', () => {
    const schema = apiSuccessResponseSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      ok: true,
      data: { id: 'match-1' },
      requestId: REQUEST_ID,
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ id: 'match-1' });
  });

  it('success 形式で ok:false を拒否する', () => {
    const schema = apiSuccessResponseSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ ok: false, data: { id: 'x' }, requestId: REQUEST_ID }).success).toBe(
      false,
    );
  });

  it('error 形式を受理し、details は既定で空オブジェクトになる', () => {
    const parsed = apiErrorResponseSchema.parse({
      ok: false,
      error: {
        code: 'MATCH_VERSION_CONFLICT',
        message: '表示を更新して再試行してください。',
      },
      requestId: REQUEST_ID,
    });

    expect(parsed.error.code).toBe('MATCH_VERSION_CONFLICT');
    expect(parsed.error.details).toEqual({});
  });

  it('requestId が uuid でなければ拒否する', () => {
    const result = apiErrorResponseSchema.safeParse({
      ok: false,
      error: { code: 'MATCH_NOT_FOUND', message: 'not found', details: {} },
      requestId: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
  });
});

describe('エラーコード（設計 §14.4）', () => {
  it('9種ちょうどである', () => {
    expect(apiErrorCodeSchema.options).toHaveLength(9);
  });

  it('設計表のコードを過不足なく含む', () => {
    expect([...apiErrorCodeSchema.options].sort()).toEqual(
      [
        'AI_OUTPUT_REJECTED',
        'AI_PROVIDER_UNAVAILABLE',
        'INVALID_HUMAN_OUTPUT',
        'INVALID_TRANSITION',
        'MATCH_BUDGET_EXCEEDED',
        'MATCH_NOT_FOUND',
        'MATCH_VERSION_CONFLICT',
        'RESULT_NOT_READY',
        'SLOT_NOT_READY',
      ].sort(),
    );
  });

  it('未知コードを拒否する', () => {
    expect(apiErrorCodeSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
  });
});
