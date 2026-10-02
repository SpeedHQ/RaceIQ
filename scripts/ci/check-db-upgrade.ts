import { join } from "node:path";

const baseRef = process.env.GITHUB_BASE_REF;
const upgradeDataDir = process.env.UPGRADE_DATA_DIR;
const runnerTemp = process.env.RUNNER_TEMP;

if (!baseRef) throw new Error("GITHUB_BASE_REF is required");
if (!upgradeDataDir) throw new Error("UPGRADE_DATA_DIR is required");
if (!runnerTemp) throw new Error("RUNNER_TEMP is required");

function run(command: string[], options: Parameters<typeof Bun.spawn>[1] = {}): void {
  const result = Bun.spawnSync(command, { ...options, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
}

run(["git", "fetch", "--no-tags", "--depth=1", "origin", baseRef]);
const changed = Bun.spawnSync(["git", "diff", "--quiet", `origin/${baseRef}`, "--", "server/db/migrations.ts"]);
if (changed.exitCode === 0) {
  console.log("No migration script changes; skipping seeded upgrade test.");
  process.exit(0);
}
if (changed.exitCode !== 1) throw new Error("Unable to compare migration script with base branch");

const baseDir = join(runnerTemp, "raceiq-base");
try {
  run(["git", "worktree", "add", "--detach", baseDir, `origin/${baseRef}`]);
  run([process.execPath, "install", "--frozen-lockfile"], { cwd: baseDir });
  run([process.execPath, "run", "db:seed", "--clean", "--games=iracing"], {
    cwd: baseDir,
    env: { ...process.env, DATA_DIR: upgradeDataDir },
  });
  run([process.execPath, "test", "./test/db/database-path.test.ts", "--timeout", "120000"], {
    env: {
      ...process.env,
      RACEIQ_DB_UPGRADE_TESTS: "1",
      RACEIQ_UPGRADE_DATA_DIR: upgradeDataDir,
    },
  });
} finally {
  run(["git", "worktree", "remove", "--force", baseDir]);
}
