import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReleaseDate, rolloverChangelog } from "@raceiq/tooling-release/tooling/render";

const rawVersion = process.argv[2];
const publishedAt = process.argv[3];
if (!rawVersion || !publishedAt) {
  throw new Error("Usage: bun packages/tooling-release/src/release/rollover-changelog.ts <version> <publishedAt>");
}
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const unreleasedPath = join(process.cwd(), "UNRELEASED.md");
const unreleased = readFileSync(unreleasedPath, "utf8");
const changelog = readFileSync(changelogPath, "utf8");
const date = formatReleaseDate(publishedAt);
const rolledChangelog = rolloverChangelog(`${unreleased.trim()}\n\n${changelog}`, { version, date });

writeFileSync(changelogPath, `${rolledChangelog}\n`);
writeFileSync(unreleasedPath, "## Unreleased\n\n### Features\n\n### Fixes\n\n### Internal\n");
console.log(`Rolled CHANGELOG.md for v${version}`);
