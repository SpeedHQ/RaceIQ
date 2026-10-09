import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["bench-standard-small", "bench-standard-large", "bench-boundary"]) {
  const work = mkdtempSync(join(tmpdir(), "raceiq-dashboard-bench-"));
  const dataDir = join(work, "data");
  mkdirSync(dataDir, { recursive: true });
  try {
    const child = Bun.spawnSync([process.execPath, "run", "apps/backend/test/benchmarks/dashboard-read-model-process.ts", mode], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", DASHBOARD_FIXTURE_MODE: mode }, stdout: "inherit", stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error(`Dashboard read-model benchmark failed for ${mode} (exit ${child.exitCode})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
