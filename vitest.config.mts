import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// unit / integration のみ。E2E は Playwright（tests/e2e）が担当する。
export default defineConfig({
  resolve: {
    alias: {
      '@': rootDir,
      // Next.js は react-server 条件で empty.js に解決する。node 実行の test でも同じにする。
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
  },
});
