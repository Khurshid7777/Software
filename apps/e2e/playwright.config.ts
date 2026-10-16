import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the Mini App in a real browser against the dev API (real PostgreSQL, deterministic
 * AI from fixtures, no Telegram): `pnpm e2e`. Needs a migrated database (DATABASE_URL); the demo catalog
 * is re-seeded by the tests themselves. Locally a preinstalled Chromium can be used via PW_CHROMIUM.
 */
const API_PORT = 3100;
const APP_PORT = 5180;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1, // the specs share one database
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: "mobile-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: [
    {
      command: "pnpm --filter @ishonch/api dev:mock",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: String(API_PORT), OPERATOR_TELEGRAM_IDS: "777000222", INTERNAL_API_TOKEN: "dev-internal-token" },
    },
    {
      command: `pnpm --filter @ishonch/miniapp exec vite --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_PROXY: `http://localhost:${API_PORT}` },
    },
  ],
});
