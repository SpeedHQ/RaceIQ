#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { collectScreenshotDiffs } from "./collect-screenshot-diffs";

function filesNamed(root: string, suffix: string, result: string[] = []): string[] {
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) filesNamed(path, suffix, result);
    else if (entry.name.endsWith(suffix)) result.push(path);
  }
  return result;
}

const [outDir, resultsDir, baseDir, currentDir, prNumber, baseRef, githubOutput] = process.argv.slice(2);
if (!outDir || !resultsDir || !baseDir || !currentDir || !prNumber || !baseRef || !githubOutput) {
  throw new Error("Usage: prepare-pr-snapshot-preview OUT RESULTS BASE CURRENT PR_NUMBER BASE_REF GITHUB_OUTPUT");
}

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, "pr-number.txt"), `${prNumber}\n`);
await Bun.write(join(outDir, "base-ref.txt"), `${baseRef}\n`);

let changed = false;
for (const diffPath of filesNamed(resultsDir, "-diff.png")) {
  const name = basename(diffPath).slice(0, -"-diff.png".length);
  const dir = dirname(diffPath);
  const before = join(dir, `${name}-expected.png`);
  const after = join(dir, `${name}-actual.png`);
  if (!existsSync(before) || !existsSync(after)) continue;
  cpSync(before, join(outDir, `changed--render-vs-committed-pr-baseline--${name}-before.png`));
  cpSync(after, join(outDir, `changed--render-vs-committed-pr-baseline--${name}-after.png`));
  cpSync(diffPath, join(outDir, `changed--render-vs-committed-pr-baseline--${name}-diff.png`));
  console.log(`changed rendered snapshot: ${name}`);
  changed = true;
}

const baseChanges = await collectScreenshotDiffs({
  baseDir,
  currentDir,
  outDir,
  prefix: "committed-pr-baseline-vs-base",
});
changed ||= baseChanges.length > 0;
await Bun.write(githubOutput, `changed=${changed ? "1" : "0"}\n`);
