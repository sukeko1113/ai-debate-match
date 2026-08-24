import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * client bundle の境界（設計 §12.1 / §19）。
 *
 * `'use client'` が付いたファイルは browser へ配られる。そこから server 側のモジュールを
 * import すると、秘密情報と Repository が bundle に載る経路ができる。
 * `OPENAI_API_KEY` を出さない番人は「接頭辞を使わない」だけでは足りず、
 * **境界を越える import が無いこと**を併せて固定する。
 *
 * client component が読んでよいのは、契約（schemas）と React・Next の公開APIだけである。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['app', 'components'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);

type SourceFile = { name: string; code: string };

function collect(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) return [];
    return [{ name: path.relative(rootDir, full), code: readFileSync(full, 'utf8') }];
  });
}

const allFiles = SCANNED_DIRS.flatMap((dir) => collect(path.join(rootDir, dir)));
const clientFiles = allFiles.filter((file) => /^\s*['"]use client['"]/.test(file.code));

function importSources(code: string): string[] {
  return [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** client から import してよい参照先。schemas と、react / next の公開API */
const ALLOWED_CLIENT_IMPORT = /^(@\/schemas(\/[\w-]+)*|react(\/[\w-]+)?|next\/[\w-]+|\.{1,2}\/[\w-]+)$/;

describe('client component は server 側を持ち込まない（設計 §12.1）', () => {
  it('走査対象を実際に読めている', () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('import 元は schemas と react / next だけである', () => {
    const offenders = clientFiles.flatMap((file) =>
      importSources(file.code)
        .filter((source) => !ALLOWED_CLIENT_IMPORT.test(source))
        .map((source) => `${file.name}: ${source}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    { label: 'infrastructure 層', pattern: /'@\/infrastructure/ },
    { label: 'application 層', pattern: /'@\/application/ },
    { label: 'domain 層', pattern: /'@\/domain/ },
    { label: 'server-only', pattern: /'server-only'/ },
    { label: 'node の I/O', pattern: /'node:/ },
    { label: '環境変数', pattern: /process\.env/ },
  ])('$label を持ち込んでいない', ({ pattern }) => {
    const offenders = clientFiles.filter((file) => pattern.test(file.code)).map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('Server Actions を使っていない（データ変更は Route Handler を通す・設計 §12）', () => {
    const offenders = allFiles
      .filter((file) => /^\s*['"]use server['"]/.test(file.code))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
