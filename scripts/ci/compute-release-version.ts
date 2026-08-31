import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const bump = process.env.RELEASE_BUMP;
const repo = process.env.REPO;
if (!bump || !repo) throw new Error("RELEASE_BUMP and REPO are required");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const parts = pkg.version.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid package version: ${pkg.version}`);
const releasedTags = execFileSync("gh", ["api", "--paginate", `repos/${repo}/releases`, "--jq", ".[] | select(.draft == false) | .tag_name"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
const releasedVersions = new Set(releasedTags.filter((tag) => tag.startsWith("v")).map((tag) => tag.slice(1)));
const increment = () => {
  if (bump === "major") { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (bump === "minor") { parts[1]++; parts[2] = 0; }
  else if (bump === "patch") parts[2]++;
  else throw new Error(`Unknown bump: ${bump}`);
};
increment();
while (releasedVersions.has(parts.join("."))) increment();
const version = parts.join(".");
appendFileSync(process.env.GITHUB_OUTPUT!, `version=${version}\n`);
console.log(`Version bump: ${pkg.version} -> ${version} (${bump}); unused released version selected`);
