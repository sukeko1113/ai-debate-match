import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * 手動スモーク専用（設計 §20 P10「manual smoke」）。
 *
 * `pnpm test` の対象外に置く。実モデルを呼ぶので CI では動かさない。
 * 鍵が無ければ、スモーク本体は skip される。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': rootDir,
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/smoke/**/*.test.ts'],
    environment: 'node',
    // 実モデルは遅い。1試合ぶんを待てるようにする
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
