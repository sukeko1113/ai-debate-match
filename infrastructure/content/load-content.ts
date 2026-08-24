import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseMockAiFixture, type MockAiFixture } from '@/schemas/ai-output';
import { parseMotion, type Motion } from '@/schemas/motion';
import { parsePersona, type Persona } from '@/schemas/persona';
import { parseRuleSet, type RuleSet } from '@/schemas/rule-set';

/**
 * 契約ファイル（設計 付録A / §12.2）の読み込み。
 *
 * - `content/` の JSON はコードから書き換えない。読むだけ。
 * - rule set と motion は読み込み時に必ず検証する（設計 §6.1 / §10.1）。
 *   壊れた契約ファイルをそのまま下流へ渡さない。検証に失敗した場合は
 *   `RuleSetValidationError` / `MotionValidationError` が、
 *   どの項目のどの条件で落ちたかを持って投げられる。
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

/** `content/motions/<fileName>.json` を読み、検証済みの motion を返す */
export function loadMotion(fileName: string = DEFAULT_MOTION_FILE): Motion {
  return parseMotion(readContentJson('motions', fileName), {
    source: `content/motions/${fileName}.json`,
  });
}

export const DEFAULT_MOCK_AI_FIXTURE_FILE = 'default';

/** `content/personas/<difficulty>.json` を読む（設計 §15.4） */
export function loadPersona(difficulty: Persona['difficulty']): Persona {
  return parsePersona(
    readContentJson('personas', difficulty),
    `content/personas/${difficulty}.json`,
  );
}

/**
 * `content/fixtures/mock-ai/<fileName>.json` を読む（設計 §15.7）。
 * 壊れた fixture をそのまま Provider へ渡さない。
 */
export function loadMockAiFixture(fileName: string = DEFAULT_MOCK_AI_FIXTURE_FILE): MockAiFixture {
  return parseMockAiFixture(
    readContentJson(path.join('fixtures', 'mock-ai'), fileName),
    `content/fixtures/mock-ai/${fileName}.json`,
  );
}
