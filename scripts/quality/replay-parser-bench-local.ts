#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const benchmarkController = "test/benchmarks/replay-parser.bench.ts";

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  console.log(`[telemetry-bench] ${command.join(" ")}`);
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}

const baseRef = argumentValue("--base") ?? process.env.BENCH_BASE_REF ?? "main";
const nodeModules = resolve(root, "node_modules");
if (!existsSync(nodeModules)) {
  throw new Error("Run bun install before the same-machine telemetry benchmark");
}
const tempRoot = mkdtempSync(join(tmpdir(), "raceiq-telemetry-compare-"));
const baseWorktree = join(tempRoot, "base");
const baseReport = join(tempRoot, "base.json");
const currentReport = join(tempRoot, "current.json");
let worktreeAdded = false;
let worktreeRemovalFailed = false;

try {
  await run(["git", "worktree", "add", "--detach", baseWorktree, baseRef], root);
  worktreeAdded = true;

  const baseBenchmark = join(baseWorktree, benchmarkController);
  if (existsSync(baseBenchmark)) {
    await run([process.execPath, "install", "--no-save", "--ignore-scripts"], baseWorktree);
    await run([process.execPath, benchmarkController, "--no-enforce", `--output=${baseReport}`], baseWorktree);
    await run([process.execPath, benchmarkController, "--no-enforce", `--output=${currentReport}`], root);
    await run([
      process.execPath,
      resolve(root, "scripts/quality/replay-parser-bench-compare.ts"),
      baseReport,
      currentReport,
      "--fail-on-regression",
    ], root);
  } else {
    console.log(`[telemetry-bench] ${baseRef} has no replay/parser benchmark; bootstrapping hard memory budgets only`);
    await run([process.execPath, benchmarkController, `--output=${currentReport}`], root);
  }
} finally {
  if (worktreeAdded) {
    try {
      await run(["git", "worktree", "remove", "--force", baseWorktree], root);
    } catch (error) {
      console.error(`[telemetry-bench] failed to remove temporary worktree ${baseWorktree}:`, error);
      worktreeRemovalFailed = true;
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
  if (worktreeRemovalFailed) {
    try {
      await run(["git", "worktree", "prune"], root);
    } catch (error) {
      console.error("[telemetry-bench] failed to prune temporary worktree metadata:", error);
    }
  }
}
