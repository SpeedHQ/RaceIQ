import { devices, defineConfig } from "@playwright/test";
import { runtime } from "./config/runtime";
import { createWebServers } from "./config/web-servers";

export default defineConfig({
  testDir: "tests/responsive",
  testMatch: "mobile-screenshots.spec.ts",
  outputDir: "./test-results/mobile-screenshots",
  fullyParallel: runtime.parallelScreenshotRun,
  workers: runtime.screenshotWorkers,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 50_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${runtime.devServer ? runtime.seeded.clientPort : runtime.seeded.port}`,
    ignoreHTTPSErrors: true,
    colorScheme: "dark",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  webServer: createWebServers(runtime),
});
