import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("screenshot render failure is unavailable comparison evidence", () => {
  const workflowOps = resolve(import.meta.dir, "../../ci/workflow-ops.ts");
  const result = Bun.spawnSync([process.execPath, workflowOps, "fail-render"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, CURRENT_STATUS: "success", BASE_STATUS: "failure" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("comparison unavailable");
});

test("complete screenshot render remains available for comparison", () => {
  const workflowOps = resolve(import.meta.dir, "../../ci/workflow-ops.ts");
  const result = Bun.spawnSync([process.execPath, workflowOps, "fail-render"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, CURRENT_STATUS: "success", BASE_STATUS: "success" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
});
test("equal valid SCM refs select full test and quality task graph", () => {
  const ref = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
  expect(ref.exitCode).toBe(0);
  const commit = ref.stdout.toString().trim();
  const result = Bun.spawnSync([
    process.execPath,
    resolve(import.meta.dir, "../run-turbo.ts"),
    "test:unit", "test:tooling", "test:integration", "lint", "typecheck", "--affected", "--dry=json",
  ], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, TURBO_SCM_BASE: commit, TURBO_SCM_HEAD: commit },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const selection = JSON.parse(result.stdout.toString()) as {
    packages: string[];
    tasks: Array<{ task: string; package: string }>;
  };
  expect(selection.packages.length).toBeGreaterThan(0);
  for (const task of ["test:unit", "test:tooling", "test:integration", "lint", "typecheck"]) {
    expect(selection.tasks.some((selected) => selected.task === task), `${task} must be executable`).toBe(true);
  }
});

test("unavailable or empty SCM ranges select full requested graph", () => {
  const script = resolve(import.meta.dir, "../run-turbo.ts");
  const cwd = resolve(import.meta.dir, "../../..");
  const ref = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  for (const range of [
    { TURBO_SCM_BASE: "", TURBO_SCM_HEAD: "" },
    { TURBO_SCM_BASE: "missing-base", TURBO_SCM_HEAD: "missing-head" },
    { TURBO_SCM_BASE: ref, TURBO_SCM_HEAD: ref },
  ]) {
    const result = Bun.spawnSync([
      process.execPath, script, "test:unit", "test:tooling", "test:integration", "lint", "typecheck", "--affected", "--dry=json",
    ], { cwd, env: { ...process.env, ...range }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const selection = JSON.parse(result.stdout.toString()) as { packages: string[]; tasks: Array<{ task: string }> };
    expect(selection.packages.length).toBeGreaterThan(0);
    for (const task of ["test:unit", "test:tooling", "test:integration", "lint", "typecheck"]) {
      expect(selection.tasks.some((selected) => selected.task === task), `${task} must be executable`).toBe(true);
    }
  }
});

test("distinct valid SCM refs retain raw Turbo affected selection", () => {
  const refs = Bun.spawnSync(["git", "rev-list", "--max-count=2", "HEAD"], { stdout: "pipe" });
  expect(refs.exitCode).toBe(0);
  const [head, base] = refs.stdout.toString().trim().split("\n");
  expect(base).toBeDefined();
  const cwd = resolve(import.meta.dir, "../../..");
  const env = { ...process.env, TURBO_SCM_BASE: base!, TURBO_SCM_HEAD: head! };
  const args = ["lint", "typecheck", "--affected", "--dry=json"];
  const runner = Bun.spawnSync([
    process.execPath, resolve(import.meta.dir, "../run-turbo.ts"), ...args,
  ], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(runner.exitCode, runner.stderr.toString()).toBe(0);
  const raw = Bun.spawnSync([
    process.execPath, resolve(cwd, "node_modules/turbo/bin/turbo"), "run", ...args,
  ], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(raw.exitCode, raw.stderr.toString()).toBe(0);
  const tasks = (output: string) => {
    const selection = JSON.parse(output) as { tasks: Array<{ task: string; package: string }> };
    return selection.tasks.map(({ task, package: packageName }) => `${packageName}#${task}`).sort();
  };
  expect(tasks(runner.stdout.toString())).toEqual(tasks(raw.stdout.toString()));
});
