import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { restoreSeededDatabase } from "./seeded-database";
import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";
import { parseSVM, writeSVM } from "@raceiq/game-lmu-metadata/setups/svm";

export function seedE2ESetupData(repoDir: string, dataDir: string): void {
  const setupHome = resolve(dataDir, "setup-home");
  const accDir = resolve(setupHome, "Documents", "Assetto Corsa Competizione", "Setups", "e2e-car", "e2e-track");
  const acEvoDir = resolve(setupHome, "Saved Games", "ACE", "Car Setups", "e2e-car", "e2e-track");
  const lmuDir = resolve(setupHome, "LMU", "UserData", "player", "Settings", "Fuji");
  mkdirSync(lmuDir, { recursive: true });
  const lmuFixture = resolve(repoDir, "packages", "game-lmu-metadata", "test", "fixtures", "SECTORFLOW_DRY_LMP3DKR_FUJ_0904_V2_Q.svm");
  copyFileSync(lmuFixture, resolve(lmuDir, "baseline.svm"));
  const parsed = parseSVM(readFileSync(lmuFixture));
  if (!parsed.ok) throw new Error(parsed.error);
  writeFileSync(resolve(lmuDir, "comparison.svm"), writeSVM(parsed.document, [{ id: "REARWING.RWSetting", delta: 1 }]));
  mkdirSync(accDir, { recursive: true });
  mkdirSync(acEvoDir, { recursive: true });
  writeFileSync(resolve(accDir, "e2e.json"), JSON.stringify({ carName: "E2E ACC Fixture", basicSetup: {} }));
  copyFileSync(resolve(repoDir, "test", "artifacts", "carsetup", "Default-12312.carsetup"), resolve(acEvoDir, "e2e.carsetup"));
}

export function seedScreenshotData(repoDir: string, dataDir: string): void {
  if (process.env.PW_SEED_SCREENSHOTS !== "1") return;
  if (process.env.PW_SEEDED_DATABASE) {
    restoreSeededDatabase(repoDir, dataDir, process.env.PW_SEEDED_DATABASE);
    return;
  }

  const result = spawnSync("bun", ["run", "apps/backend/scripts/data/seed-db.ts", `--games=${process.env.PW_SEED_GAMES ?? DEFAULT_GAMES.join(",")}`], {
    cwd: repoDir,
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Screenshot database seed failed with exit code ${result.status ?? "unknown"}`);
  }
}
