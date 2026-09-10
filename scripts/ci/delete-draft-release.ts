export {};
const tag = process.env.RELEASE_TAG;
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
if (!tag || !repo || !token) throw new Error("RELEASE_TAG, REPO, and GH_TOKEN are required");
const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
if (!response.ok) throw new Error(`GitHub releases API failed: ${response.status} ${await response.text()}`);
const releases = await response.json() as Array<{ id: number; draft: boolean; tag_name: string }>;
for (const release of releases.filter((item) => item.draft && item.tag_name === tag)) {
  console.log(`Deleting existing draft release ${release.id} for ${tag}`);
  const deleted = await fetch(`https://api.github.com/repos/${repo}/releases/${release.id}`, { method: "DELETE", headers });
  if (!deleted.ok) throw new Error(`Failed to delete draft release ${release.id}: ${deleted.status} ${await deleted.text()}`);
}
console.log(`Preserving any existing released tag ${tag}`);
