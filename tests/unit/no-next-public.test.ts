import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 受入基準: `NEXT_PUBLIC_` で始まる環境変数がコードに存在しない。
 * OPENAI_API_KEY を client bundle へ出さないための最小の番人（設計 §12.1 / §19）。
 * この test 自身がリテラルを含まないよう、接頭辞は連結して作る。
 */
const FORBIDDEN_PREFIX = `NEXT_${'PUBLIC'}_`;

const SCANNED_DIRS = [
  'app',
  'components',
  'domain',
  'application',
  'infrastructure',
  'schemas',
  'tests',
];
const SCANNED_FILES = ['next.config.ts', 'playwright.config.ts', 'vitest.config.mts'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.css']);

const selfPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(selfPath), '..', '..');

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) return [];
    return [full];
  });
}

describe(`${FORBIDDEN_PREFIX} を使っていない`, () => {
  it('ソースツリーに1件も現れない', () => {
    const files = [
      ...SCANNED_DIRS.flatMap((dir) => collectFiles(path.join(rootDir, dir))),
      ...SCANNED_FILES.map((file) => path.join(rootDir, file)),
    ].filter((file) => path.resolve(file) !== selfPath);

    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(FORBIDDEN_PREFIX));

    expect(offenders).toEqual([]);
  });

  it('scan 対象のファイルを実際に読めている', () => {
    for (const dir of SCANNED_DIRS) {
      expect(statSync(path.join(rootDir, dir)).isDirectory()).toBe(true);
    }
    expect(SCANNED_DIRS.flatMap((dir) => collectFiles(path.join(rootDir, dir))).length).toBeGreaterThan(0);
  });
});
