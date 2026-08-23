import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 受入基準4 / 設計 §12.1:
 * `domain/rules/` は React・fetch・DB client・環境変数を import しない。
 *
 * import 元は「契約（schemas）」と「同じディレクトリ内」だけに限る。
 * 依存方向が逆転していないことを、白リストで固定する。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rulesDir = path.join(rootDir, 'domain', 'rules');

/** 注意書きに禁止語そのものを書けるよう、コメントを外してから走査する */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sourceFiles = readdirSync(rulesDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({
    name,
    code: stripComments(readFileSync(path.join(rulesDir, name), 'utf8')),
  }));

/** import / export ... from '...' の参照先を集める */
function importSources(code: string): string[] {
  return [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

const ALLOWED_IMPORT = /^(@\/schemas(\/[\w-]+)*|\.\/[\w-]+)$/;

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '環境変数', pattern: /process\.env/ },
  { label: 'fetch', pattern: /\bfetch\s*\(/ },
  { label: 'server-only', pattern: /'server-only'/ },
  { label: 'React', pattern: /'react(-dom)?'/ },
  { label: 'Next.js', pattern: /'next\// },
  { label: 'DB client', pattern: /'(pg|postgres|@supabase\/[\w-]+|drizzle-orm|@prisma\/client)'/ },
  { label: 'infrastructure 層', pattern: /'@\/infrastructure/ },
  { label: 'application 層', pattern: /'@\/(app|application|components)/ },
  { label: 'node の I/O', pattern: /'node:(fs|http|https|net)'/ },
];

describe('domain/rules は純関数だけを持つ（受入基準4 / 設計 §12.1）', () => {
  it('走査対象のファイルを実際に読めている', () => {
    expect(sourceFiles.map((file) => file.name).sort()).toEqual([
      'duties.ts',
      'index.ts',
      'seconds.ts',
      'slots.ts',
    ]);
    // コメントを外しても本体が残っていること（走査が空振りしていない）
    for (const file of sourceFiles) {
      expect(file.code).toContain('export');
    }
  });

  it.each(FORBIDDEN_PATTERNS)('$label を使っていない', ({ pattern }) => {
    const offenders = sourceFiles
      .filter((file) => pattern.test(file.code))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('import 元は schemas と同ディレクトリだけである', () => {
    const offenders = sourceFiles.flatMap((file) =>
      importSources(file.code)
        .filter((source) => !ALLOWED_IMPORT.test(source))
        .map((source) => `${file.name}: ${source}`),
    );
    expect(offenders).toEqual([]);
  });
});
