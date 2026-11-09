import { hasUnreleasedChangelogChange } from "@raceiq/tooling-release/tooling/validation";
if (process.env.GITHUB_EVENT_NAME !== "pull_request") process.exit(0);

const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef) throw new Error("GITHUB_BASE_REF is required for pull-request changelog checks");

const diff = Bun.spawnSync(["git", "diff", "--unified=3", `origin/${baseRef}`, "HEAD", "--", "UNRELEASED.md"]);
if (diff.exitCode !== 0) throw new Error("Unable to compare UNRELEASED.md with the pull-request base branch");

const baseFiles = Bun.spawnSync(["git", "ls-tree", "--name-only", `origin/${baseRef}`, "--", "UNRELEASED.md"]);
if (baseFiles.exitCode !== 0) throw new Error("Unable to inspect the pull-request base branch");
const baseChangelog = baseFiles.stdout.length > 0
  ? Bun.spawnSync(["git", "show", `origin/${baseRef}:UNRELEASED.md`])
  : undefined;
if (baseChangelog && baseChangelog.exitCode !== 0) throw new Error("Unable to read UNRELEASED.md from the pull-request base branch");

const patch = new TextDecoder().decode(diff.stdout);
const before = baseChangelog ? new TextDecoder().decode(baseChangelog.stdout) : "";
const after = await Bun.file("UNRELEASED.md").text();
if (!hasUnreleasedChangelogChange(patch, before, after)) {
  console.error("UNRELEASED.md must add a note for this pull request.");
  process.exit(1);
}

console.log("UNRELEASED.md contains a new note.");
