#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const previewDir = process.argv[2] ?? "pr-preview";
const diffs = readdirSync(previewDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith("-diff.png"))
  .map((entry) => join(previewDir, entry.name));

if (diffs.length > 0) {
  console.error(`::error::Committed Storybook snapshots do not match (${diffs.length} diff(s)).`);
  for (const diff of diffs) console.error(`::error::Snapshot mismatch artifact: ${basename(diff)}`);
  console.error("Download 'pr-screenshot-preview' artifact for before/after/diff images.");
} else {
  console.error("::error::Storybook snapshot test failed without generating visual diff artifacts.");
  console.error("::error::Inspect 'Render and compare against committed baselines' step for the underlying test or server failure.");
}

process.exitCode = 1;
