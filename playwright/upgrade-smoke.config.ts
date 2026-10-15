import { mkdirSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const artifactDir = process.env.RACEIQ_UPGRADE_ARTIFACTS_DIR
  ? resolve(process.env.RACEIQ_UPGRADE_ARTIFACTS_DIR)
  : resolve(repoRoot, "playwright/test-results/source-upgrade");
mkdirSync(artifactDir, { recursive: true });
const replay = process.env.RACEIQ_UPGRADE_REPLAY === "1";

export default defineConfig({
  testDir: "./tests/upgrade",
  testMatch: "source-release.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: resolve(artifactDir, "browser"),
  reporter: [["list"], ["html", { outputFolder: resolve(artifactDir, "report"), open: "never" }], ["json", { outputFile: resolve(artifactDir, "results.json") }]],
  use: {
    trace: replay ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: replay ? "on" : "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    headless: true,
  },
});
