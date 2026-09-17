#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectScreenshotDiffs } from "./collect-screenshot-diffs";

const positional = process.argv.slice(2);
const values = positional.length
  ? positional
  : [
      process.env.PR_SNAPSHOT_OUT_DIR,
      process.env.PR_SNAPSHOT_BASE_RENDER_DIR,
      process.env.PR_SNAPSHOT_CURRENT_RENDER_DIR,
      process.env.PR_SNAPSHOT_NUMBER,
      process.env.PR_SNAPSHOT_BASE_REF,
    ];
const [outDir, baseRenderDir, currentRenderDir, prNumber, baseRef] = values;
if (!outDir || !baseRenderDir || !currentRenderDir || !prNumber || !baseRef) {
  throw new Error(
    "Usage: prepare-pr-snapshot-preview OUT BASE_RENDER CURRENT_RENDER PR_NUMBER BASE_REF " +
      "or PR_SNAPSHOT_* environment variables",
  );
}

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, "pr-number.txt"), `${prNumber}\n`);
await Bun.write(join(outDir, "base-ref.txt"), `${baseRef}\n`);
await collectScreenshotDiffs({
  baseDir: baseRenderDir,
  currentDir: currentRenderDir,
  outDir,
  prefix: "rendered-base-vs-pr",
});
