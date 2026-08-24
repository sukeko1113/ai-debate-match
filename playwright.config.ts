import { defineConfig, devices } from '@playwright/test';

/**
 * E2E（設計 §21.3 の E01〜E12）。
 *
 * シナリオごとに**サーバの設定が違う**。fixture の差し替え（`MOCK_AI_FIXTURE`）も
 * 上限の引き下げ（`MAX_AI_RUNS_PER_MATCH`）も起動時に決まるため、1つのサーバでは賄えない。
 * 設定ごとにポートを分けて起動し、project で振り分ける。
 *
 * build は1回だけ行う（`pnpm test:e2e` が `pnpm build` を先に走らせる）。
 * ここでの各サーバは `pnpm start` だけを行う。
 *
 * `CLOCK_MODE=manual` はローカルと CI でのみ使う（設計 §22）。E10 がこれを確かめる。
 */

const BASE_PORT = Number(process.env.PORT ?? 3000);

const SCENARIOS = [
  { name: 'default', port: BASE_PORT, env: {} },
  { name: 'hardening', port: BASE_PORT + 1, env: { MOCK_AI_FIXTURE: 'hardening' } },
  { name: 'budget', port: BASE_PORT + 2, env: { MAX_AI_RUNS_PER_MATCH: '5' } },
  { name: 'no-argument', port: BASE_PORT + 3, env: { MOCK_AI_FIXTURE: 'no-argument' } },
] as const;

const urlOf = (port: number): string => `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : '50%',
  reporter: process.env.CI ? 'line' : 'list',
  use: { trace: 'on-first-retry' },

  projects: SCENARIOS.map((scenario) => ({
    name: scenario.name,
    testDir: `./tests/e2e/${scenario.name}`,
    use: { ...devices['Desktop Chrome'], baseURL: urlOf(scenario.port) },
  })),

  webServer: SCENARIOS.map((scenario) => ({
    // production build を対象にする。build は test:e2e が先に1回だけ行う
    command: 'pnpm start',
    url: urlOf(scenario.port),
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Phase 1 の既定。CI でも同じ値を使う（設計 §22）
    env: {
      AI_PROVIDER: 'mock',
      PERSISTENCE_PROVIDER: 'memory',
      CLOCK_MODE: 'manual',
      PORT: String(scenario.port),
      ...scenario.env,
    },
  })),
});
