#!/usr/bin/env bun
function run(args: string[], capture = false): string {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`);
  return capture ? new TextDecoder().decode(result.stdout).trim() : "";
}

const baseRef = process.env.BASE_REF;
const baseSha = process.env.BASE_SHA;
const runnerTemp = process.env.RUNNER_TEMP;
if (!baseRef || !baseSha || !runnerTemp) throw new Error("BASE_REF, BASE_SHA, and RUNNER_TEMP are required");

run(["config", "user.name", "github-actions[bot]"]);
run(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
run(["fetch", "--no-tags", "origin", `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`]);
let fetchedBaseSha = run(["rev-parse", "--verify", "FETCH_HEAD"], true);
if (fetchedBaseSha !== baseSha) {
  run(["fetch", "--no-tags", "origin", baseSha]);
  fetchedBaseSha = run(["rev-parse", "--verify", "FETCH_HEAD"], true);
}
if (fetchedBaseSha !== baseSha) throw new Error(`Fetched base commit ${fetchedBaseSha} does not match ${baseSha}`);
run(["merge", "--no-edit", baseSha]);
run(["worktree", "add", "--detach", `${runnerTemp}/raceiq-base`, baseSha]);
export {};
