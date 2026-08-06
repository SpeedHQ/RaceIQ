import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReleaseDate, rolloverChangelog } from "@shared/tooling/render";

const version = process.argv[2];
const publishedAt = process.argv[3];
if (!version || !publishedAt) {
  throw new Error("Usage: bun scripts/release/rollover-changelog.ts <version> <publishedAt>");
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const date = formatReleaseDate(publishedAt);
const rolledChangelog = rolloverChangelog(changelog, { version, date });

writeFileSync(changelogPath, `${rolledChangelog}\n`);
console.log(`Rolled CHANGELOG.md for v${version}`);
