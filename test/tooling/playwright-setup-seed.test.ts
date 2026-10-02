import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedE2ESetupData } from "../../playwright/support/server/seed-screenshot-data";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Playwright E2E setup data", () => {
  test("seeds selectable ACC and AC Evo setup files", () => {
    tempDir = mkdtempSync(join(tmpdir(), "raceiq-e2e-setup-"));

    seedE2ESetupData(process.cwd(), tempDir);

    const accSetup = join(tempDir, "setup-home", "Documents", "Assetto Corsa Competizione", "Setups", "e2e-car", "e2e-track", "e2e.json");
    const acEvoSetup = join(tempDir, "setup-home", "Saved Games", "ACE", "Car Setups", "e2e-car", "e2e-track", "e2e.carsetup");

    expect(JSON.parse(readFileSync(accSetup, "utf8"))).toMatchObject({ carName: "E2E ACC Fixture", basicSetup: {} });
    expect(readFileSync(acEvoSetup).length).toBeGreaterThan(0);
  });
});
