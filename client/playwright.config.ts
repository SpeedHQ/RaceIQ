import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/stories",
  testMatch: "**/*.snapshot.ts",
  outputDir: "./src/stories/__snapshots__/results",
  snapshotDir: "./src/stories/__snapshots__",
  snapshotPathTemplate: "{snapshotDir}/{testName}.png",
  use: {
    baseURL: "http://localhost:6006",
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
    screenshot: "on",
  },
  webServer: {
    command: "bun run storybook",
    url: "http://localhost:6006",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
