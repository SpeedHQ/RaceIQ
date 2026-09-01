import { appendFileSync } from "node:fs";
import { computeNextReleaseVersion, type Bump } from "./release-version";

const bump = process.env.RELEASE_BUMP;
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
if (!bump || !repo || !token) throw new Error("RELEASE_BUMP, REPO, and GH_TOKEN are required");
if (bump !== "major" && bump !== "minor" && bump !== "patch") throw new Error(`Unknown bump: ${bump}`);
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
const version = computeNextReleaseVersion(releasedTags, bump as Bump);
appendFileSync(process.env.GITHUB_OUTPUT!, `version=${version}\n`);
console.log(`Version bump from latest release tag -> ${version} (${bump}); unused released version selected`);
