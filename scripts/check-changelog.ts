import { hasUnreleasedChangelogChange } from "../shared/changelog-ci";

if (process.env.GITHUB_EVENT_NAME !== "pull_request") process.exit(0);

const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef) throw new Error("GITHUB_BASE_REF is required for pull-request changelog checks");

const diff = Bun.spawnSync(["git", "diff", "--unified=3", `origin/${baseRef}`, "HEAD", "--", "CHANGELOG.md"]);
if (diff.exitCode !== 0) throw new Error("Unable to compare CHANGELOG.md with the pull-request base branch");

const baseChangelog = Bun.spawnSync(["git", "show", `origin/${baseRef}:CHANGELOG.md`]);
if (baseChangelog.exitCode !== 0) throw new Error("Unable to read CHANGELOG.md from the pull-request base branch");

const patch = new TextDecoder().decode(diff.stdout);
const before = new TextDecoder().decode(baseChangelog.stdout);
const after = await Bun.file("CHANGELOG.md").text();
if (!hasUnreleasedChangelogChange(patch, before, after)) {
  console.error("CHANGELOG.md must add a note under ## Unreleased for this pull request.");
  process.exit(1);
}

console.log("CHANGELOG.md contains a new ## Unreleased note.");
