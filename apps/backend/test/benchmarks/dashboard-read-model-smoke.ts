import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["smoke-standard-small", "smoke-standard-large", "smoke-boundary"]) {
  const work = mkdtempSync(join(tmpdir(), "raceiq-dashboard-smoke-"));
  const dataDir = join(work, "data");
  mkdirSync(dataDir, { recursive: true });
  try {
    const child = Bun.spawnSync([process.execPath, "run", "apps/backend/test/benchmarks/dashboard-read-model-process.ts", mode], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "0", DASHBOARD_FIXTURE_MODE: mode }, stdout: "inherit", stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error(`Dashboard read-model smoke failed for ${mode} (exit ${child.exitCode})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
