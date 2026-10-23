import { resolve } from "node:path";
import { discoverTestOwners } from "./owners";

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
  const available = refs.every((ref) => ref && Bun.spawnSync(
    ["git", "rev-parse", "--verify", `${ref}^{commit}`],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0);
  if (!available) {
    console.error("Affected SCM refs unavailable; running full task selection.");
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

const proc = Bun.spawn(
  [process.execPath, resolve(root, "node_modules/turbo/bin/turbo"), "run", ...args],
  { cwd: root, env, stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
