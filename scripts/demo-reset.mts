/**
 * demo reset（設計 §19 / P12）。
 *
 * ```
 * pnpm demo:reset <matchId>
 * ```
 *
 * 指定した試合の配下を**1トランザクションで**消す。子テーブルは
 * `on delete cascade` で落ちる（`supabase/migrations/0001_init.sql`）。
 *
 * **HTTP の口は作らない。** 設計 §14.3 のエンドポイント表に delete は無い。
 * 消せるのは Postgres だけである。既定の Memory はプロセス内にしか無く、
 * 別プロセスから消す口を持たない（止めれば消える）。
 *
 * 接続文字列は表示しない（設計 §19）。
 */

import { Pool } from 'pg';

/** `.env.local` → `.env` の順に読む。既に環境にあるものは上書きしない */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // 無ければ読まない
    }
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const matchId = process.argv[2];
  if (matchId === undefined || matchId === '') {
    fail('使い方: pnpm demo:reset <matchId>');
  }

  loadEnvFiles();
  const connectionString = process.env['DATABASE_URL'] ?? '';
  if (connectionString === '') {
    fail('DATABASE_URL が無い。demo reset は Postgres に対してだけ行える（ADR 0001 / 設計 §19）。');
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query('delete from matches where id = $1', [matchId]);
      await client.query('commit');

      if ((result.rowCount ?? 0) === 0) {
        process.stdout.write(`match が見つからない（id=${matchId}）。何も消していない。\n`);
        return;
      }
      process.stdout.write(`match と配下をすべて消した（id=${matchId}）。\n`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// 失敗の中身に接続文字列は含めない（設計 §19）
main().catch((error: unknown) => {
  fail(`demo reset に失敗した: ${error instanceof Error ? error.message : '原因不明'}`);
});
