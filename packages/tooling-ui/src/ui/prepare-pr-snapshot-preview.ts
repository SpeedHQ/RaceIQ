#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
for (const [name, source] of [["base-storybook", baseRenderDir], ["current-storybook", currentRenderDir]]) {
  const target = join(outDir, name);
  if (existsSync(source)) cpSync(source, target, { recursive: true });
  else mkdirSync(target, { recursive: true });
}
