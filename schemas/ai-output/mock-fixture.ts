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
 *
 * CX は同じ (role, sectionNo) が往復ごとに呼ばれる（設計 §7）。`cxTurnIndex` を
 * 指定した行はその往復だけに使われ、往復と再試行の並びが混ざらない。
 * 省略した行は往復を区別せず、呼ばれた順に `outputs` を進める。
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
  /** CXの往復位置。省略すると往復を区別しない */
  cxTurnIndex: z.number().int().min(0).nullable().default(null),
  outputs: z.array(z.unknown()).min(1),
});

export type MockAiResponse = z.infer<typeof mockAiResponseSchema>;
/** 書く側の形。`cxTurnIndex` を省略できる */
export type MockAiResponseInput = z.input<typeof mockAiResponseSchema>;

export const mockAiFixtureSchema = z.strictObject({
  code: z.string().min(1),
  responses: z.array(mockAiResponseSchema).min(1),
});

export type MockAiFixture = z.infer<typeof mockAiFixtureSchema>;
export type MockAiFixtureInput = z.input<typeof mockAiFixtureSchema>;

export function parseMockAiFixture(input: unknown, source?: string): MockAiFixture {
  const result = mockAiFixtureSchema.safeParse(input);
  if (result.success) return result.data;

  const where = source === undefined ? '' : `（${source}）`;
  throw new Error(`Mock AI fixture の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`);
}
