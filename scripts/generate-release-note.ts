import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { renderAllReleaseNotes, renderUnreleasedBody } from "../shared/release-notes/render";
const version = process.argv[2];
if (!version) throw new Error("Usage: bun scripts/generate-release-note.ts <version>");

const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const notes = renderUnreleasedBody(changelog);
if (!notes) throw new Error(`CHANGELOG.md has no release notes under ## Unreleased for v${version}`);

writeFileSync("releasenote.md", `${notes}\n`);
writeFileSync("releasenotes.md", `${renderAllReleaseNotes(changelog)}\n`);
console.log(`Generated releasenote.md and releasenotes.md for v${version}`);
