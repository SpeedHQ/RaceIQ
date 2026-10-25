import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd());
const tsconfig = resolve(repoRoot, "playwright/tsconfig.json");

export default defineConfig({
  testDir: repoRoot,
  testMatch: [
    "packages/game-lmu/test/e2e/browser/compare/lmu-opponent-cold-load.spec.ts",
    "packages/game-lmu/test/e2e/browser/compare/lmu-opponents.spec.ts",
    "packages/sessions-page/test/e2e/navigation.spec.ts",
  ],
  tsconfig,
  grep: /\[(?:E2|E7|E9)\]/,
  outputDir: resolve(repoRoot, "playwright/test-results/opponent-cold-load"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 20 * 60 * 1000,
  expect: { timeout: 60_000 },
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
