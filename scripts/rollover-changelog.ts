import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { formatReleaseDate, rolloverChangelog } from "../shared/changelog";

const version = process.argv[2];
const publishedAt = process.argv[3];
if (!version || !publishedAt) {
  throw new Error("Usage: bun scripts/rollover-changelog.ts <version> <publishedAt>");
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const date = formatReleaseDate(publishedAt);
const rolledChangelog = rolloverChangelog(changelog, { version, date });

writeFileSync(changelogPath, rolledChangelog);
console.log(`Rolled CHANGELOG.md for v${version}`);
