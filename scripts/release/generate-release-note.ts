import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReleaseDate, renderAllReleaseNotes, renderUnreleasedBody } from "@shared/tooling/render";
const version = process.argv[2];
const publishedAt = process.argv[3];
if (!version) throw new Error("Usage: bun scripts/release/generate-release-note.ts <version> [publishedAt]");

const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const notes = renderUnreleasedBody(changelog);
if (!notes) throw new Error(`CHANGELOG.md has no release notes under ## Unreleased for v${version}`);
const release = publishedAt === undefined ? { version } : { version, date: formatReleaseDate(publishedAt) };

writeFileSync("releasenote.md", `${notes}\n`);
writeFileSync("releasenotes.md", `${renderAllReleaseNotes(changelog, release)}\n`);
console.log(`Generated releasenote.md and releasenotes.md for v${version}`);
