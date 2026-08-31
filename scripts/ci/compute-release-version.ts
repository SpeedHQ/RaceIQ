import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const bump = process.env.RELEASE_BUMP;
if (!bump) throw new Error("RELEASE_BUMP is required");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const parts = pkg.version.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid package version: ${pkg.version}`);
const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
const used = new Set(tags.map((tag) => tag.slice(1)));
const increment = () => {
  if (bump === "major") { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (bump === "minor") { parts[1]++; parts[2] = 0; }
  else if (bump === "patch") parts[2]++;
  else throw new Error(`Unknown bump: ${bump}`);
};
increment();
while (used.has(parts.join("."))) increment();
const version = parts.join(".");
appendFileSync(process.env.GITHUB_OUTPUT!, `version=${version}\n`);
console.log(`Version bump: ${pkg.version} -> ${version} (${bump}); unused tag selected`);
