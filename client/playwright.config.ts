import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/stories",
  testMatch: "**/*.snapshot.ts",
  outputDir: "./src/stories/__snapshots__/results",
  snapshotDir: "./src/stories/__snapshots__",
  snapshotPathTemplate: "{snapshotDir}/{testName}.png",
  // Tolerate sub-pixel antialiasing / font-rendering noise so only real UI
  // changes trip the diff. `threshold` is per-pixel colour distance (0–1);
  // `maxDiffPixelRatio` is the fraction of pixels allowed to differ overall.
  expect: {
    toHaveScreenshot: {
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: "http://localhost:6006",
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
    screenshot: "on",
    // Freeze motion-driven UI (e.g. the redline strobe) so snapshots are
    // deterministic across runs.
    reducedMotion: "reduce",
  },
  webServer: {
    command: "bun run storybook",
    url: "http://localhost:6006",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
