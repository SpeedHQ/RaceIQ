import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverTestOwners } from "./owners";
import { generateTurboInputs } from "./turbo-inputs";

const root = resolve(import.meta.dir, "../..");
let args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length === 0) {
  console.error("Usage: bun scripts/test/run-turbo.ts <task...> [Turbo run options]");
  process.exit(2);
}

const env: Record<string, string | undefined> = {
  ...process.env,
  RACEIQ_TEST_PLATFORM: process.platform,
  RACEIQ_TEST_ARCH: process.arch,
  RACEIQ_TEST_BUN_VERSION: Bun.version,
};
if (args.includes("--affected")) {
  const refs = [env.TURBO_SCM_BASE, env.TURBO_SCM_HEAD];
  const explicit = refs.some((ref) => ref !== undefined);
  const resolved = [refs[0] ?? "main", refs[1] ?? "HEAD"].map((ref) => {
    if (ref === "") return undefined;
    const result = Bun.spawnSync(
      ["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  });
  const [base, head] = resolved;
  const shallow = Bun.spawnSync(
    ["git", "rev-parse", "--is-shallow-repository"],
    { cwd: root, stdout: "pipe", stderr: "ignore" },
  );
  const commonHistory = base && head && Bun.spawnSync(
    ["git", "merge-base", base, head],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0;
  if (shallow.exitCode !== 0 || shallow.stdout.toString().trim() !== "false" || !commonHistory || (explicit && base === head)) {
    console.error("Affected SCM range unavailable or empty; running full task selection.");
    args = args.filter((arg) => arg !== "--affected");
    delete env.TURBO_SCM_BASE;
    delete env.TURBO_SCM_HEAD;
  }
}

const firstOption = args.findIndex((arg) => arg.startsWith("-"));
const tasks = args.slice(0, firstOption < 0 ? args.length : firstOption);
if (tasks.length > 0 && tasks.every((task) => task === "test" || task.startsWith("test:")) &&
    !args.some((arg) => arg === "--filter" || arg.startsWith("--filter="))) {
  for (const owner of discoverTestOwners(root, { includeDisabled: true })) {
    if (owner.disabled) args.push(`--filter=!${owner.name}`);
  }
}

const needsSuiteInputs = tasks.some((task) =>
  ["test:unit", "test:tooling", "test:integration", "test:e2e:recordings"].includes(task));
let generatedDir: string | undefined;
try {
  if (needsSuiteInputs) {
    const config = generateTurboInputs(root);
    generatedDir = mkdtempSync(resolve(tmpdir(), "raceiq-turbo-inputs-"));
    const path = resolve(generatedDir, "turbo.json");
    writeFileSync(path, config);
    args.push(`--root-turbo-json=${path}`);
  }
  const proc = Bun.spawn(
    [process.execPath, resolve(root, "node_modules/turbo/bin/turbo"), "run", ...args],
    { cwd: root, env, stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await proc.exited;
} finally {
  if (generatedDir) rmSync(generatedDir, { recursive: true, force: true });
}
