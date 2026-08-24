import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

/**
 * Postgres を使う test の下ごしらえ（ADR 0001 / 設計 §21.2）。
 *
 * **`DATABASE_URL` が無ければ Postgres の test は走らない。**
 * CI は鍵もDBも持たないため、既定の Memory だけで全テストが通る必要がある（設計 §22）。
 *
 * このファイルは test の道具であり、実装からは import されない。
 */

export const POSTGRES_URL = process.env['DATABASE_URL'] ?? '';
export const hasPostgres = POSTGRES_URL !== '';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = path.join(rootDir, 'supabase', 'migrations');

/**
 * migration を当てる。既にテーブルがあれば何もしない。
 * `supabase` CLI が無い環境でも test を走らせられるようにするための最小の口である。
 */
export async function ensureSchema(): Promise<void> {
  const pool = new Pool({ connectionString: POSTGRES_URL, max: 1 });
  try {
    const found = await pool.query<{ table: string | null }>(
      "select to_regclass('public.matches')::text as table",
    );
    if (found.rows[0]?.table !== null && found.rows[0]?.table !== undefined) return;

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const file of files) {
      await pool.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
  } finally {
    await pool.end();
  }
}
