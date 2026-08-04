import { defineConfig, devices } from "@playwright/test";
import { createProjects } from "./config/projects";
import { runtime } from "./config/runtime";
import { createWebServers } from "./config/web-servers";

export default defineConfig({
  testDir: "tests",
  outputDir: "./test-results",
  fullyParallel: runtime.parallelScreenshotRun,
  workers: runtime.parallelScreenshotRun ? runtime.screenshotWorkers : 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    ignoreHTTPSErrors: true,
    colorScheme: "dark",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  projects: createProjects(runtime),
  webServer: createWebServers(runtime),
});
