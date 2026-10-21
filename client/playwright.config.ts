import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { VISUAL_DIFF_COLOR_THRESHOLD, VISUAL_DIFF_MAX_PIXEL_RATIO } from "@raceiq/tooling-ui/ui/visual-diff-config";

const STORYBOOK_PORT = process.env.RACEIQ_STORYBOOK_PORT ?? "6006";
const STORYBOOK_ROOT = process.env.RACEIQ_STORYBOOK_ROOT ? resolve(process.env.RACEIQ_STORYBOOK_ROOT) : undefined;
const SNAPSHOT_DIR = process.env.RACEIQ_SNAPSHOT_DIR ? resolve(process.env.RACEIQ_SNAPSHOT_DIR) : "./src/stories/__snapshots__";
const RESULTS_DIR = process.env.RACEIQ_SNAPSHOT_RESULTS_DIR ? resolve(process.env.RACEIQ_SNAPSHOT_RESULTS_DIR) : "./src/stories/__snapshots__/results";
const SNAPSHOT_TEST_DIR = process.env.RACEIQ_SNAPSHOT_TEST_DIR ?? "./src/stories";
const SERVE_PREBUILT = process.env.RACEIQ_STORYBOOK_PREBUILT === "1";
const CLIENT_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CLIENT_ROOT, "..");
const BUILD_HELPER = resolve(REPOSITORY_ROOT, "packages/tooling-ui/src/ui/build-storybook.ts");

const storybookCommand = [
  SERVE_PREBUILT
    ? `bun --cwd "${REPOSITORY_ROOT}" "${BUILD_HELPER}" --client-root "${STORYBOOK_ROOT ?? CLIENT_ROOT}" --verify`
    : `bun --cwd "${REPOSITORY_ROOT}" "${BUILD_HELPER}" --client-root "${STORYBOOK_ROOT ?? CLIENT_ROOT}"`,
  `bunx vite preview --outDir storybook-static --host 0.0.0.0 --port ${STORYBOOK_PORT} --strictPort`,
].join(" && ");
export default defineConfig({
  testDir: SNAPSHOT_TEST_DIR,
  testMatch: "**/*.snapshot.ts",
  // Each snapshot opens a full Storybook page with chart/image state. Keeping
  // one worker prevents concurrent Chromium pages from exhausting CI memory.
  workers: 1,
  outputDir: RESULTS_DIR,
  snapshotDir: SNAPSHOT_DIR,
  snapshotPathTemplate: "{snapshotDir}/{testName}.png",
  // snapshot-test initializes absent baselines; existing differences must fail.
  updateSnapshots: "missing",
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
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    // Build through shared helper locally; CI validates prebuilt historical or
    // current assets and serves without compiling again.
    command: storybookCommand,
    cwd: STORYBOOK_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
    url: `http://localhost:${STORYBOOK_PORT}/index.json`,
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
