import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import {
  API_DIR,
  API_PORT,
  OWNER_STATE_PATH,
  SINGLE_ORIGIN,
  USE_BUILD,
  WEB_DIR,
  WEB_PORT,
  WEB_URL,
  apiEnv,
} from './e2e/support/env';

/*
 * End-to-end tests against the real API and a dedicated, freshly prepared database. `pnpm e2e`
 * from the repository root; see e2e/support/env.ts.
 *
 * Servers (never reused: a dev server already on a port fails the run instead of being tested
 * against the development database), started in this order:
 * - the API on :4000. Its command first prepares the database (prepare-db.mjs: drop, bootstrap,
 *   migrate, seed), because Playwright starts web servers before globalSetup;
 * - from the sources only: the web app on the Vite dev server (:5173, `/api` proxied to the API).
 *   With the builds (E2E_USE_BUILD=1 in CI), the API serves the web app at / itself: one origin,
 *   as in production.
 *
 * Projects:
 * - setup: the owner's session (auth.setup.ts);
 * - chromium: the web app on a desktop (e2e/*.spec.ts).
 *
 * The tests share one database, so they run serially (one worker).
 */

const CI = Boolean(process.env['CI']);

/**
 * Chromium of this Playwright version when installed (`playwright install chromium`, CI);
 * otherwise a preinstalled one (PLAYWRIGHT_CHROMIUM_PATH, default /opt/pw-browsers/chromium).
 */
function chromiumExecutable(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const fallback = process.env['PLAYWRIGHT_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
  return existsSync(fallback) ? fallback : undefined;
}
const executablePath = chromiumExecutable();

const support = (script: string) => `node "${WEB_DIR}/e2e/support/${script}"`;
const apiCommand = USE_BUILD ? 'node dist/server.js' : 'pnpm exec tsx src/server.ts';

const projects: PlaywrightTestConfig['projects'] = [
  { name: 'setup', testMatch: /.*\.setup\.ts/ },
  {
    name: 'chromium',
    testMatch: /\/e2e\/[^/]+\.spec\.ts$/,
    dependencies: ['setup'],
    use: { ...devices['Desktop Chrome'], storageState: OWNER_STATE_PATH },
  },
];

const webServers: NonNullable<PlaywrightTestConfig['webServer']> = [
  {
    command: `${support('prepare-db.mjs')} && ${apiCommand}`,
    cwd: API_DIR,
    url: `http://127.0.0.1:${API_PORT}/health/ready`,
    env: apiEnv,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
];
if (!SINGLE_ORIGIN) {
  webServers.push({
    command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
    cwd: WEB_DIR,
    url: WEB_URL,
    env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  });
}

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    locale: 'es-PE',
    // Not the organization's zone (America/Lima): times must follow the record, not the browser.
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects,
  webServer: webServers,
});
