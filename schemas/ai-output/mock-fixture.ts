import { z } from 'zod';

/**
 * Mock AI の fixture（設計 §15.7）。
 *
 * `content/fixtures/mock-ai/*.json` の形をここで決める。契約ファイルの検証は schemas の役目で、
 * Provider 実装の中に置かない。壊れた fixture をそのまま Provider へ渡さないためである。
 *
 * `outputs` は**試行順**である。並びがそのまま再試行の筋書きになる（設計 §15.5）。
 * 出力そのものは role ごとに形が違うため、ここでは検証しない。
 * 役割別 schema（argument key の enum を注入済み）が Provider の中で検証する。
 */
export const mockAiResponseSchema = z.strictObject({
  role: z.enum([
    'constructive',
    'cx_question',
    'cx_answer',
    'attack',
    'defense',
    'summary',
    'judge',
  ]),
  sectionNo: z.number().int().min(1),
  outputs: z.array(z.unknown()).min(1),
});

export type MockAiResponse = z.infer<typeof mockAiResponseSchema>;

export const mockAiFixtureSchema = z.strictObject({
  code: z.string().min(1),
  responses: z.array(mockAiResponseSchema).min(1),
});

export type MockAiFixture = z.infer<typeof mockAiFixtureSchema>;

export function parseMockAiFixture(input: unknown, source?: string): MockAiFixture {
  const result = mockAiFixtureSchema.safeParse(input);
  if (result.success) return result.data;

  const where = source === undefined ? '' : `（${source}）`;
  throw new Error(`Mock AI fixture の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`);
}
