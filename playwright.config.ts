/**
 * Playwright E2E configuration (e2e/*.spec.ts).
 *
 *  - One project: iPhone 14 viewport/UA emulated in CHROMIUM (CI installs
 *    chromium only; the device descriptor's webkit default is overridden).
 *  - webServer runs the REAL production server (`e2e/run-server.mjs`): it
 *    builds the client + the esbuild server bundle, then starts it on port
 *    8197 with a fresh temp SQLite db. CI pre-builds and sets E2E_SKIP_BUILD=1.
 *  - Tests share that one server process (each test creates its own room), so
 *    they run serially with a single worker for determinism.
 *  - the app defaults to Finnish (a persisted `hp:lang` toggle, with no
 *    browser-locale sniffing), so the lobby helpers force English at runtime via
 *    the on-screen toggle (see gotoEnglish); the specs assert English UI strings.
 *    A pre-seeded storageState is deliberately NOT used — Playwright applies it
 *    before app-boot only on fast hardware, so it booted Finnish on CI runners.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 8197;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // Two-browser-context specs (two-humans) are timing-sensitive; a rare
  // intermittent shouldn't block the deploy gate. Locally keep 0 for fast,
  // honest feedback.
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  /* Bots act with a humanizing 500-1500 ms delay; full deals take minutes. */
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-14-chromium',
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
      },
    },
  ],
  webServer: {
    command: 'node e2e/run-server.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
