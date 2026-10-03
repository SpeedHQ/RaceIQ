#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import { basename } from "node:path";

const previewDir = process.argv[2] ?? "pr-preview";
const diffNames = readdirSync(previewDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith("-diff.png"))
  .map((entry) => entry.name);
if (diffNames.length > 0) {
  console.error(`::warning::Base and PR Storybook renders differ (${diffNames.length} diff(s)).`);
  for (const diff of diffNames) console.error(`::warning::Visual difference artifact: ${basename(diff)}`);
  console.error("Download 'pr-screenshot-preview' artifact for before/after/diff images.");
}

console.error("::warning::Base or PR Storybook snapshot render failed; visual review artifact may be incomplete.");
console.error("::warning::Inspect snapshot render steps for underlying test or server failure. Comparison is advisory.");
