/**
 * Playwright configuration for the samorev landing page e2e tests.
 *
 * Serves site/ via Python's http.server on port 4321 so the tests run against
 * the actual static files — no mock, no build step needed.
 *
 * CI installs playwright browsers via `npx playwright install --with-deps chromium`.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/scenarios",
  timeout: 15_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4321",
    headless: true,
  },
  webServer: {
    command: "python3 -m http.server 4321 --directory site",
    port: 4321,
    reuseExistingServer: false,
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  reporter: "list",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
