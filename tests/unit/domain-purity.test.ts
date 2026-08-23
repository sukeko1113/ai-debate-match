import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 受入基準9 / 設計 §12.1:
 * `domain/` 配下のどのファイルも React・fetch・DB client・環境変数・fs を import しない。
 *
 * P2 では `domain/rules` だけを見ていた。P3 で `domain/match` `domain/cx` `domain/fallback`
 * `domain/repositories` が加わったので、走査範囲を `domain/` 全体へ広げる。
 * 新しいディレクトリを足したときに白リストの外へ出ないよう、再帰で拾う。
 *
 * import 元は「契約（schemas）」と「domain 内」だけに限る。
 * infrastructure が domain を実装する向きは正しいが、逆向きは依存方向の反転である。
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

const ALLOWED_IMPORT = /^(@\/schemas(\/[\w-]+)*|@\/domain(\/[\w-]+)*|\.{1,2}\/[\w-]+(\/[\w-]+)*)$/;

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '環境変数', pattern: /process\.env/ },
  { label: 'fetch', pattern: /\bfetch\s*\(/ },
  { label: 'server-only', pattern: /'server-only'/ },
  { label: 'React', pattern: /'react(-dom)?'/ },
  { label: 'Next.js', pattern: /'next\// },
  { label: 'DB client', pattern: /'(pg|postgres|@supabase\/[\w-]+|drizzle-orm|@prisma\/client)'/ },
  { label: 'infrastructure 層', pattern: /'@\/infrastructure/ },
  { label: 'application 層', pattern: /'@\/(app|application|components)/ },
  { label: 'node の I/O', pattern: /'node:(fs|http|https|net|child_process)'/ },
  { label: 'fs', pattern: /\brequire\s*\(\s*'fs'\s*\)/ },
];

describe('domain は純関数と契約だけを持つ（受入基準9 / 設計 §12.1）', () => {
  it('P3 で加わったディレクトリも走査している', () => {
    const directories = new Set(
      sourceFiles.map((file) => file.name.split('/')[0] ?? '').filter((name) => name !== ''),
    );
    for (const required of ['rules', 'match', 'cx', 'fallback', 'repositories']) {
      expect(directories).toContain(required);
    }
    // コメントを外しても本体が残っていること（走査が空振りしていない）
    expect(sourceFiles.length).toBeGreaterThanOrEqual(14);
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

  it('import 元は schemas と domain 内だけである', () => {
    const offenders = sourceFiles.flatMap((file) =>
      importSources(file.code)
        .filter((source) => !ALLOWED_IMPORT.test(source))
        .map((source) => `${file.name}: ${source}`),
    );
    expect(offenders).toEqual([]);
  });

  it('時計と乱数を持たない。同じ入力から常に同じ結果が出る（設計 §15.7）', () => {
    const offenders = sourceFiles
      .filter((file) => /\bDate\.now\s*\(|new Date\s*\(|Math\.random\s*\(|crypto\./.test(file.code))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
