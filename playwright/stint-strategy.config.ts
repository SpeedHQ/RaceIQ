import { defineConfig, devices } from "@playwright/test";

/** Strategy scenarios own their isolated app processes, data and lifecycle controls. */
export default defineConfig({
  testDir: "tests/seeded/strategy",
  outputDir: "test-results/stint-strategy",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: { ...devices["Desktop Chrome"], colorScheme: "dark", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "seeded-e2e" }],
});
