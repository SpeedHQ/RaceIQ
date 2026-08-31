import { appendFileSync, readFileSync } from "node:fs";

const bump = process.env.RELEASE_BUMP;
if (!bump) throw new Error("RELEASE_BUMP is required");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const parts = pkg.version.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid package version: ${pkg.version}`);
if (bump === "major") { parts[0]++; parts[1] = 0; parts[2] = 0; }
else if (bump === "minor") { parts[1]++; parts[2] = 0; }
else if (bump === "patch") parts[2]++;
else throw new Error(`Unknown bump: ${bump}`);
const version = parts.join(".");
appendFileSync(process.env.GITHUB_OUTPUT!, `version=${version}\n`);
console.log(`Version bump: ${pkg.version} -> ${version} (${bump})`);
