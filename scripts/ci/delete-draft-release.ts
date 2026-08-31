import { execFileSync } from "node:child_process";

const tag = process.env.RELEASE_TAG;
const repo = process.env.REPO;
if (!tag || !repo) throw new Error("RELEASE_TAG and REPO are required");
const ids = execFileSync("gh", ["api", `repos/${repo}/releases`, "--jq", `.[] | select(.tag_name == "${tag}" and .draft) | .id`], { encoding: "utf8" }).trim();
for (const id of ids ? ids.split(/\s+/) : []) {
  console.log(`Deleting existing draft release ${id} for ${tag}`);
  execFileSync("gh", ["api", "-X", "DELETE", `repos/${repo}/releases/${id}`], { stdio: "inherit" });
}
console.log(`Preserving any existing released tag ${tag}`);
