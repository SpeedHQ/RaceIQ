import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { VISUAL_DIFF_COLOR_THRESHOLD, VISUAL_DIFF_MAX_PIXEL_RATIO } from "../scripts/ui/visual-diff-config";

const STORYBOOK_PORT = process.env.RACEIQ_STORYBOOK_PORT ?? "6006";
const STORYBOOK_ROOT = process.env.RACEIQ_STORYBOOK_ROOT ? resolve(process.env.RACEIQ_STORYBOOK_ROOT) : undefined;
const SNAPSHOT_DIR = process.env.RACEIQ_SNAPSHOT_DIR ? resolve(process.env.RACEIQ_SNAPSHOT_DIR) : "./src/stories/__snapshots__";
const RESULTS_DIR = process.env.RACEIQ_SNAPSHOT_RESULTS_DIR ? resolve(process.env.RACEIQ_SNAPSHOT_RESULTS_DIR) : "./src/stories/__snapshots__/results";

export default defineConfig({
  testDir: "./src/stories",
  testMatch: "**/*.snapshot.ts",
  // Static Storybook is built once and serves concurrent snapshot pages.
  // Two workers match the constrained CI runner's two vCPUs.
  workers: 2,
  outputDir: RESULTS_DIR,
  snapshotDir: SNAPSHOT_DIR,
  snapshotPathTemplate: "{snapshotDir}/{testName}.png",
  // Tolerate sub-pixel antialiasing / font-rendering noise so only real UI
  // changes trip the diff. `threshold` is per-pixel colour distance (0–1);
  // `maxDiffPixelRatio` is the fraction of pixels allowed to differ overall.
  expect: {
    toHaveScreenshot: {
      threshold: VISUAL_DIFF_COLOR_THRESHOLD,
      maxDiffPixelRatio: VISUAL_DIFF_MAX_PIXEL_RATIO,
    },
  },
  use: {
    baseURL: `http://localhost:${STORYBOOK_PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
    screenshot: "on",
    // Freeze motion-driven UI (e.g. the redline strobe) so snapshots are
    // deterministic across runs.
    reducedMotion: "reduce",
  },
  webServer: {
    // Storybook's Vite preview can exceed Node's default ~2 GB heap while
    // compiling the full snapshot inventory in the constrained CI runner.
    command: `bunx storybook build --test --output-dir storybook-static && bunx vite preview --outDir storybook-static --host 0.0.0.0 --port ${STORYBOOK_PORT} --strictPort`,
    cwd: STORYBOOK_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
    url: `http://localhost:${STORYBOOK_PORT}/index.json`,
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
