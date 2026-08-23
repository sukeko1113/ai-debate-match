import { z } from 'zod';

import { motionSchema, type Motion } from './motion';

/**
 * motion の検証入口（設計 §10.1 / §15.6）。
 * rule set と同じく、どの項目で落ちたかがそのまま読めるメッセージにする。
 */

export class MotionValidationError extends Error {
  override readonly name = 'MotionValidationError';
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[]) {
    super(message);
    this.issues = issues;
  }
}

export type ParseMotionOptions = {
  /** エラーメッセージに出す出所。ファイル名など */
  source?: string;
};

export function safeParseMotion(input: unknown) {
  return motionSchema.safeParse(input);
}

/** 検証に通らなければ `MotionValidationError` を投げる */
export function parseMotion(input: unknown, options: ParseMotionOptions = {}): Motion {
  const result = safeParseMotion(input);
  if (result.success) return result.data;

  const where = options.source === undefined ? '' : `（${options.source}）`;
  throw new MotionValidationError(
    `motion の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`,
    result.error.issues,
  );
}
