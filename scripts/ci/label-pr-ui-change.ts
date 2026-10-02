import { execFileSync } from "node:child_process";

const repo = process.env.REPO!;
const pr = process.env.PR!;
const label = process.env.LABEL!;
const changed = process.env.CHANGED === "true";

if (changed) {
  try {
    execFileSync("gh", ["label", "create", label, "--repo", repo, "--color", "FFC0CB", "--description", "Pull request changes rendered dashboard UI"], { stdio: "inherit" });
  } catch {
    // Label may already exist; continue to apply it.
  }
}
execFileSync("gh", ["pr", "edit", pr, "--repo", repo, changed ? "--add-label" : "--remove-label", label], { stdio: "inherit" });
