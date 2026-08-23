import { z } from 'zod';

import { ruleSetSchema, type RuleSet } from './rule-set';

/**
 * rule set の検証入口（設計 §6.1）。
 *
 * 失敗したときは、どのスロットのどの条件で落ちたかがそのまま読めるメッセージにする。
 * `z.prettifyError` が issue ごとに `→ at slots[7].respondentSeat` を付けるため、
 * message 側にも index と key を書いてある。
 */

export class RuleSetValidationError extends Error {
  override readonly name = 'RuleSetValidationError';
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[]) {
    super(message);
    this.issues = issues;
  }
}

export type ParseRuleSetOptions = {
  /** エラーメッセージに出す出所。ファイル名など */
  source?: string;
};

export function safeParseRuleSet(input: unknown) {
  return ruleSetSchema.safeParse(input);
}

/** 検証に通らなければ `RuleSetValidationError` を投げる */
export function parseRuleSet(input: unknown, options: ParseRuleSetOptions = {}): RuleSet {
  const result = safeParseRuleSet(input);
  if (result.success) return result.data;

  const where = options.source === undefined ? '' : `（${options.source}）`;
  throw new RuleSetValidationError(
    `rule set の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`,
    result.error.issues,
  );
}
