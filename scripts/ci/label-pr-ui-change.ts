import { execFileSync } from "node:child_process";

const repo = process.env.REPO!;
const pr = process.env.PR!;
const label = process.env.LABEL!;
try {
  execFileSync("gh", ["label", "create", label, "--repo", repo, "--color", "FFC0CB", "--description", "Pull request changes rendered dashboard UI"], { stdio: "inherit" });
} catch {
  // Label may already exist; continue to apply it.
}
execFileSync("gh", ["pr", "edit", pr, "--repo", repo, "--add-label", label], { stdio: "inherit" });
