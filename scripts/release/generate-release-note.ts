import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderUnreleasedBody } from "@shared/tooling/render";
const version = process.argv[2];
if (!version) throw new Error("Usage: bun scripts/release/generate-release-note.ts <version> [publishedAt]");

const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const notes = renderUnreleasedBody(changelog);
if (!notes) throw new Error(`CHANGELOG.md has no release notes under ## Unreleased for v${version}`);
writeFileSync("releasenote.md", `${notes}\n`);
console.log(`Generated releasenote.md for v${version}`);
