#!/usr/bin/env bun
function run(args: string[]): number {
  return Bun.spawnSync(["git", ...args], { stdout: "inherit", stderr: "inherit" }).exitCode;
}

const targetRef = process.env.TARGET_REF;
if (!targetRef) throw new Error("TARGET_REF is required");
if (run(["config", "user.name", "github-actions[bot]"]) !== 0) process.exit(1);
if (run(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]) !== 0) process.exit(1);
if (run(["add", "client/src/stories/__snapshots__/snapshot-*.png", "assets/screenshots"]) !== 0) process.exit(1);
if (Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { stdout: "inherit", stderr: "inherit" }).exitCode === 0) {
  console.log("Baselines already match CI render.");
  process.exit(0);
}
if (run(["commit", "-m", "chore(ci): regenerate dashboard baselines in CI env [skip ci]"]) !== 0) process.exit(1);
if (run(["push", "origin", `HEAD:${targetRef}`]) !== 0) process.exit(1);
export {};
