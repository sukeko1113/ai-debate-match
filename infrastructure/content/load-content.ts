import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseRuleSet, type RuleSet } from '@/schemas/rule-set';

/**
 * 契約ファイル（設計 付録A / §12.2）の読み込み。
 *
 * - `content/` の JSON はコードから書き換えない。読むだけ。
 * - rule set は読み込み時に必ず検証する（設計 §6.1）。壊れた rule set を
 *   そのまま下流へ渡さない。検証に失敗した場合は
 *   `RuleSetValidationError` が、どのスロットのどの条件で落ちたかを持って投げられる。
 * - motion の Zod 検証は、motion 自身の schema を作る PR で行う。
 *   P2 の範囲は rule set のみのため、戻り値は `unknown` のままにしてある。
 * - 引数はファイル名（拡張子なし）である。motion の `code` はファイル名と一致しない
 *   （`demo-motion-ja.json` の code は `demo_bukatsu_ja`）。
 */

export const DEFAULT_RULE_SET_FILE = 'henda_20th_2025_42_v1';
export const DEFAULT_MOTION_FILE = 'demo-motion-ja';

const CONTENT_DIR = path.join(process.cwd(), 'content');
const FILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function readContentJson(subDir: string, fileName: string): unknown {
  if (!FILE_NAME_PATTERN.test(fileName)) {
    throw new Error(`契約ファイル名が不正です: ${fileName}`);
  }
  const raw = readFileSync(path.join(CONTENT_DIR, subDir, `${fileName}.json`), 'utf8');
  return JSON.parse(raw) as unknown;
}

/** `content/rule-sets/<fileName>.json` を読み、検証済みの rule set を返す */
export function loadRuleSet(fileName: string = DEFAULT_RULE_SET_FILE): RuleSet {
  return parseRuleSet(readContentJson('rule-sets', fileName), {
    source: `content/rule-sets/${fileName}.json`,
  });
}

/** `content/motions/<fileName>.json` を読む */
export function loadMotionJson(fileName: string = DEFAULT_MOTION_FILE): unknown {
  return readContentJson('motions', fileName);
}
