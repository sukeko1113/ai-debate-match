import { z } from 'zod';

import {
  argumentStateSchema,
  cxModeSchema,
  cxPhaseSchema,
  matchStatusSchema,
  occupantTypeSchema,
  seatSchema,
  sideSchema,
  slotProgressStatusSchema,
} from '../common';
import { ruleSlotSchema } from '../rule-set';

/**
 * MatchSnapshot（設計 付録B）。**client が読む唯一の形**である。
 *
 * ここに無いものを client へ渡さない。とくに未来スロットの内容は含めない（設計 §18.1）。
 * `winner` や `score` も含めない。判定結果は `GET /result`（P9）が返す。
 *
 * 進行位置は snapshot を読むだけで復元できる必要がある。再読込のたびに
 * 同じ slot・同じ CX往復位置へ戻れることが、この形の役目である（設計 §3.2 画面復帰）。
 */

/** いまクライアントが次に行うこと（設計 付録B currentAction） */
export const currentActionSchema = z.enum([
  'input_constructive',
  'input_answer',
  'wait_ai',
  'skip_prep',
  'advance',
  'judge',
  'view_result',
]);

export type CurrentAction = z.infer<typeof currentActionSchema>;

/** フローシートの1行。常に4件以下である（設計 §9.1 / 付録B） */
export const flowSheetRowSchema = z.strictObject({
  argumentKey: z.string().min(1),
  side: sideSchema,
  label: z.string().min(1),
  state: argumentStateSchema,
  originSection: z.number().int().min(1),
});

export const matchSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  status: matchStatusSchema,
  version: z.number().int().min(0),
  motion: z.strictObject({
    code: z.string().min(1),
    textJa: z.string().min(1),
  }),
  ruleSet: z.strictObject({
    code: z.string().min(1),
    version: z.number().int().min(1),
    status: z.literal('verified_public_rule_source'),
  }),
  /** 進行中のスロット。rule set の定義をそのまま渡す。UI は秒数も席も自分で持たない */
  currentSlot: ruleSlotSchema.nullable(),
  /** CXスロットにいるときだけ非 null（設計 §7） */
  cx: z
    .strictObject({
      phase: cxPhaseSchema,
      turnCursor: z.number().int().min(0),
      total: z.number().int().min(1),
      mode: cxModeSchema,
    })
    .nullable(),
  seats: z
    .array(
      z.strictObject({
        seat: seatSchema,
        occupantType: occupantTypeSchema,
        displayName: z.string().min(1),
      }),
    )
    .length(8, { error: '席割りは8席ちょうどである（設計 §13）' }),
  /** 全スロットの進捗。未来スロットの中身は含めない（設計 §18.1） */
  progress: z.array(
    z.strictObject({
      slotIndex: z.number().int().min(0),
      status: slotProgressStatusSchema,
    }),
  ),
  currentAction: currentActionSchema.nullable(),
  flowSheet: z
    .array(flowSheetRowSchema)
    .max(4, { error: 'フローシートは常に4行以下である（設計 §9.1）' }),
  aiRunsUsed: z.number().int().min(0),
  /** 直前の失敗を表示に残したいときだけ使う。通常の失敗は §14.2 の封筒で返す */
  error: z
    .strictObject({
      code: z.string().min(1),
      retryable: z.boolean(),
    })
    .nullable(),
});

export type MatchSnapshot = z.infer<typeof matchSnapshotSchema>;

/** 返す前に必ず通す。schema を迂回して返さない（CLAUDE.md 禁止事項の趣旨） */
export function parseMatchSnapshot(value: unknown): MatchSnapshot {
  const result = matchSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`MatchSnapshot の組み立てに失敗した:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
