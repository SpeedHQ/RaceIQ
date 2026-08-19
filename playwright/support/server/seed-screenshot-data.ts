import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function seedE2ESetupData(repoDir: string, dataDir: string): void {
  const setupHome = resolve(dataDir, "setup-home");
  const accDir = resolve(setupHome, "Documents", "Assetto Corsa Competizione", "Setups", "e2e-car", "e2e-track");
  const acEvoDir = resolve(setupHome, "Saved Games", "ACE", "Car Setups", "e2e-car", "e2e-track");
  mkdirSync(accDir, { recursive: true });
  mkdirSync(acEvoDir, { recursive: true });
  writeFileSync(resolve(accDir, "e2e.json"), JSON.stringify({ carName: "E2E ACC Fixture", basicSetup: {} }));
  copyFileSync(resolve(repoDir, "test", "artifacts", "carsetup", "Default-12312.carsetup"), resolve(acEvoDir, "e2e.carsetup"));
}

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
