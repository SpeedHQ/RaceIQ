import { appendFileSync, readFileSync } from "node:fs";

const bump = process.env.RELEASE_BUMP;
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
if (!bump || !repo || !token) throw new Error("RELEASE_BUMP, REPO, and GH_TOKEN are required");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const parts = pkg.version.split(".").map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid package version: ${pkg.version}`);
const releasedTags: string[] = [];
for (let page = 1; ; page++) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub releases API failed: ${response.status} ${await response.text()}`);
  const releases = await response.json() as Array<{ draft: boolean; tag_name: string }>;
  releasedTags.push(...releases.filter((release) => !release.draft).map((release) => release.tag_name));
  if (releases.length < 100) break;
}
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
