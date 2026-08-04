import { spawnSync } from "node:child_process";

export function seedScreenshotData(repoDir: string, dataDir: string): void {
  if (process.env.PW_SEED_SCREENSHOTS !== "1") return;

  const result = spawnSync("bun", ["run", "scripts/data/seed-db.ts", "--reset"], {
    cwd: repoDir,
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Screenshot database seed failed with exit code ${result.status ?? "unknown"}`);
  }
}
