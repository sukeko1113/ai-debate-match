import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 受入基準9 / 設計 §12.1:
 * `domain/` 配下は React・fetch・DB client・環境変数・ファイルIOを import しない。
 *
 * import 元は「契約（schemas）」「domain 内の別モジュール」「同じディレクトリ」だけに限る。
 * 依存方向が逆転していないことを、白リストで固定する。
 * P2 では domain/rules だけを見ていた。P3 で domain 配下すべてへ広げている。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const domainDir = path.join(rootDir, 'domain');

/** 注意書きに禁止語そのものを書けるよう、コメントを外してから走査する */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

type SourceFile = { name: string; code: string };

function collect(dir: string, prefix = ''): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return collect(full, name);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ name, code: stripComments(readFileSync(full, 'utf8')) }];
  });
}

const sourceFiles = collect(domainDir);

/** import / export ... from '...' の参照先を集める */
function importSources(code: string): string[] {
  return [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

const ALLOWED_IMPORT = /^(@\/(schemas|domain)(\/[\w-]+)*|\.\/[\w-]+)$/;

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
  { label: 'ファイルIO', pattern: /\b(readFileSync|readdirSync|writeFileSync)\b/ },
];

/** 受入基準9 が名指ししているディレクトリ。走査から漏れていないことを確かめる */
const REQUIRED_DIRECTORIES = ['cx', 'fallback', 'match', 'repositories', 'rules'];

describe('domain 配下は純関数だけを持つ（受入基準9 / 設計 §12.1）', () => {
  it('走査対象のファイルを実際に読めている', () => {
    const directories = [
      ...new Set(sourceFiles.map((file) => file.name.split('/')[0] ?? '')),
    ].sort();
    expect(directories).toEqual(REQUIRED_DIRECTORIES);

    for (const directory of REQUIRED_DIRECTORIES) {
      expect(
        sourceFiles.filter((file) => file.name.startsWith(`${directory}/`)).length,
        `${directory} のファイルが見つからない`,
      ).toBeGreaterThan(0);
    }
    // コメントを外しても本体が残っていること（走査が空振りしていない）
    for (const file of sourceFiles) {
      expect(file.code, file.name).toContain('export');
    }
  });

  it.each(FORBIDDEN_PATTERNS)('$label を使っていない', ({ pattern }) => {
    const offenders = sourceFiles.filter((file) => pattern.test(file.code)).map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('import 元は schemas・domain・同ディレクトリだけである', () => {
    const offenders = sourceFiles.flatMap((file) =>
      importSources(file.code)
        .filter((source) => !ALLOWED_IMPORT.test(source))
        .map((source) => `${file.name}: ${source}`),
    );
    expect(offenders).toEqual([]);
  });

  it('乱数と時刻を使わない（reducer の決定性）', () => {
    const offenders = sourceFiles
      .filter((file) => /Math\.random|Date\.now|new Date\(/.test(file.code))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
