#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import { basename } from "node:path";

const previewDir = process.argv[2] ?? "pr-preview";
const diffNames = readdirSync(previewDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith("-diff.png"))
  .map((entry) => entry.name);
const renderDiffs = diffNames.filter((name) => name.includes("--rendered-base-vs-pr--"));
const baselineDiffs = diffNames.filter((name) => name.includes("--render-vs-committed-pr-baseline--"));
const unknownDiffs = diffNames.filter((name) => !renderDiffs.includes(name) && !baselineDiffs.includes(name));

if (renderDiffs.length > 0) {
  console.error(`::warning::Base and PR Storybook renders differ (${renderDiffs.length} diff(s)).`);
  for (const diff of renderDiffs) console.error(`::warning::Expected visual change artifact: ${basename(diff)}`);
}

const errors = [...baselineDiffs, ...unknownDiffs];
if (errors.length > 0) {
  console.error(`::error::Rendered snapshots differ from committed PR baselines (${errors.length} diff(s)).`);
  for (const diff of errors) console.error(`::error::Snapshot baseline mismatch artifact: ${basename(diff)}`);
} else {
  console.error("::error::Storybook snapshot test failed without a committed-baseline mismatch.");
  console.error("::error::Inspect the PR render step for the underlying test or server failure.");
}

if (diffNames.length > 0) console.error("Download 'pr-screenshot-preview' artifact for before/after/diff images.");
process.exit(1);
