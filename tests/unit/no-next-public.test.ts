import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 受入基準: client bundle に載りうるコードへ、client 公開用の接頭辞つき環境変数が現れない。
 * OPENAI_API_KEY を client bundle へ出さないための最小の番人（設計 §12.1 / §19）。
 *
 * 検索文字列はソースに書かず実行時に組み立てる。
 * 走査対象は bundle に載りうるディレクトリだけに限り、
 * tests / docs / .env.example / CLAUDE.md / README.md は対象外とする。
 * これらは「その接頭辞を使わない」という注意書きを日本語で書ける場所である。
 */
const FORBIDDEN_PREFIX = `${['NEXT', 'PUBLIC'].join('_')}_`;

/** client bundle に載りうるディレクトリのみ */
const SCANNED_DIRS = ['app', 'components', 'domain', 'application', 'infrastructure', 'schemas'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.css']);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) return [];
    return [full];
  });
}

const scannedFiles = SCANNED_DIRS.flatMap((dir) => collectFiles(path.join(rootDir, dir)));

describe('client 公開用の接頭辞つき環境変数を使っていない', () => {
  it('bundle に載りうるディレクトリに1件も現れない', () => {
    const offenders = scannedFiles
      .filter((file) => readFileSync(file, 'utf8').includes(FORBIDDEN_PREFIX))
      .map((file) => path.relative(rootDir, file));

    expect(offenders).toEqual([]);
  });

  it('走査対象のディレクトリとファイルを実際に読めている', () => {
    for (const dir of SCANNED_DIRS) {
      expect(statSync(path.join(rootDir, dir)).isDirectory()).toBe(true);
    }
    expect(scannedFiles.length).toBeGreaterThan(0);
  });

  it('注意書きを書ける場所は走査していない', () => {
    const excluded = ['tests', 'docs', '.env.example', 'CLAUDE.md', 'README.md'].map((entry) =>
      path.join(rootDir, entry),
    );

    for (const file of scannedFiles) {
      expect(excluded.some((entry) => file === entry || file.startsWith(`${entry}${path.sep}`))).toBe(
        false,
      );
    }
  });
});
