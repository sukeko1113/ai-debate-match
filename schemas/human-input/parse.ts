import { z } from 'zod';

import {
  buildConstructiveInputSchema,
  type ConstructiveInput,
  type ConstructiveLimits,
} from './constructive';

/**
 * 構造化立論の検証入口（設計 §8.1 / §14.4）。
 *
 * 失敗は例外ではなく issue の配列で返す。呼び出し側が
 * `INVALID_HUMAN_OUTPUT`（人間の入力）と `AI_OUTPUT_REJECTED`（AIの出力）へ
 * 同じ形から振り分けられるようにするためである（設計 §14.4 / §15.5）。
 */

export type ConstructiveInputIssue = {
  /** どのフィールドか。例: `arguments.0.body` */
  readonly path: string;
  readonly message: string;
};

export type ConstructiveParseResult =
  | { readonly ok: true; readonly value: ConstructiveInput }
  | { readonly ok: false; readonly issues: readonly ConstructiveInputIssue[] };

function pathOf(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0 ? '(root)' : issue.path.join('.');
}

export function parseConstructiveInput(
  limits: ConstructiveLimits,
  input: unknown,
): ConstructiveParseResult {
  const result = buildConstructiveInputSchema(limits).safeParse(input);
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: pathOf(issue),
      message: issue.message,
    })),
  };
}
