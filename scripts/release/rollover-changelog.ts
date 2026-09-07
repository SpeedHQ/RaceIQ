import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReleaseDate, rolloverChangelog } from "@shared/tooling/render";

const rawVersion = process.argv[2];
const publishedAt = process.argv[3];
if (!rawVersion || !publishedAt) {
  throw new Error("Usage: bun scripts/release/rollover-changelog.ts <version> <publishedAt>");
}
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const date = formatReleaseDate(publishedAt);
const rolledChangelog = rolloverChangelog(changelog, { version, date });

writeFileSync(changelogPath, `${rolledChangelog}\n`);
console.log(`Rolled CHANGELOG.md for v${version}`);
