import { readFileSync, writeFileSync } from "node:fs";

const rawVersion = process.argv[2];
if (!rawVersion) throw new Error("Usage: bun scripts/ci/update-release-version.ts <version-or-tag>");
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
const path = "package.json";
const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
pkg.version = version;
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
