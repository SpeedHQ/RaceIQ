import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCarSetupFile, carSetupToKnobValues } from "@raceiq/game-ac-evo/carsetup";

// `getSetupsBaseDir` derives the Setups folder from `os.homedir()`. Bun's
// homedir() reads the OS password database on POSIX, so setting HOME/USERPROFILE
// does NOT redirect it (works on Windows, silently no-ops on the Linux CI box —
// the guard then rejects every temp-dir path, and the real home gets a stray
// "Saved Games/ACE/Car Setups" created in it). Patch the module instead.
let homeOverride: string | null = null;
mock.module("os", () => ({
  ...os,
  homedir: () => homeOverride ?? os.homedir(),
}));

const FIXTURE = join(ROOT_DIR, "test/artifacts/carsetup/Default-12312.carsetup");
const AUDI_D3 = join(ROOT_DIR, "test/artifacts/carsetup/audi-default-3.carsetup");

describe("resolveGuardedSetupFile with .carsetup", () => {
  const fakeHome = join(tmpdir(), `raceiq-carsetup-test-${process.pid}`);
  const setupsDir = join(fakeHome, "Saved Games", "ACE", "Car Setups");
  beforeAll(async () => {
    const { initServerGameAdapters } = await import("../../../src/games/init");
    initServerGameAdapters();
    mkdirSync(setupsDir, { recursive: true });
    copyFileSync(FIXTURE, join(setupsDir, "Default-12312.carsetup"));
    writeFileSync(join(setupsDir, "corrupt.carsetup"), "not a protobuf file at all");
    homeOverride = fakeHome;
  });

  afterAll(() => {
    homeOverride = null;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("decodes .carsetup into knob values and flags read-only", async () => {
    const { resolveGuardedSetupFile } = await import("../../../src/setups/file-guard");
    const guarded = await resolveGuardedSetupFile("ac-evo", join(setupsDir, "Default-12312.carsetup"));
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(guarded.setup).not.toBeNull();
    expect(guarded.setup.frontARB).toBe(3);
    expect(guarded.setup.brakeBias).toBeCloseTo(52.6, 1);
    expect(guarded.readOnly).toBe(true);
  });

  it("keeps setup null (not a crash) when the .carsetup doesn't decode", async () => {
    const { resolveGuardedSetupFile } = await import("../../../src/setups/file-guard");
    const guarded = await resolveGuardedSetupFile("ac-evo", join(setupsDir, "corrupt.carsetup"));
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(guarded.setup).toBeNull();
    expect(guarded.readOnly).toBe(true);
  });
});

describe("writeAppliedSetup .carsetup", () => {
  const fakeHome = join(tmpdir(), `raceiq-carsetup-write-test-${process.pid}`);
  const setupsDir = join(fakeHome, "Saved Games", "ACE", "Car Setups");
  beforeAll(async () => {
    const { initServerGameAdapters } = await import("../../../src/games/init");
    initServerGameAdapters();
    mkdirSync(setupsDir, { recursive: true });
    copyFileSync(FIXTURE, join(setupsDir, "Default-12312.carsetup"));
    homeOverride = fakeHome;
  });

  afterAll(() => {
    homeOverride = null;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("byte-patches a real .carsetup base and writes a NEW sibling file, never overwriting the original", async () => {
    const { writeAppliedSetup } = await import("../../../src/setups/io");
    const original = await readCarSetupFile(join(setupsDir, "Default-12312.carsetup"));
    const knobs = carSetupToKnobValues(original!);

    const written = await writeAppliedSetup("ac-evo", {
      baseDir: setupsDir,
      realPath: join(setupsDir, "Default-12312.carsetup"),
      setup: { ...knobs, brakeBias: (knobs.brakeBias ?? 50) + 1 },
      stem: "test-v2",
    });

    expect(written.setupPath).not.toBeNull();
    expect(written.setupPath).not.toBe(join(setupsDir, "Default-12312.carsetup"));
    expect(written.setupSnapshot).toBeNull();

    // Original untouched.
    const stillOriginal = await readCarSetupFile(join(setupsDir, "Default-12312.carsetup"));
    expect(carSetupToKnobValues(stillOriginal!).brakeBias).toBeCloseTo(knobs.brakeBias!, 3);

    // New file reads back with the patched value.
    const rewritten = await readCarSetupFile(written.setupPath!);
    expect(carSetupToKnobValues(rewritten!).brakeBias).toBeCloseTo(knobs.brakeBias! + 1, 2);
  });

  it("falls back to an advisory snapshot branch when the base has no realPath", async () => {
    const { writeAppliedSetup } = await import("../../../src/setups/io");
    const written = await writeAppliedSetup("ac-evo", {
      baseDir: null,
      realPath: null,
      setup: { frontARB: 3 },
      stem: "test-v2",
    });
    expect(written.setupPath).toBeNull();
    expect(written.setupSnapshot).toBe(JSON.stringify({ frontARB: 3 }));
    expect(written.fileName).toContain("(advisory)");
  });

  it("integration: decode -> applyIntents -> write reproduces the same apply_changes pipeline the Setup Engineer tool uses on a .carsetup session", async () => {
    const { resolveGuardedSetupFile } = await import("../../../src/setups/file-guard");
    const { writeAppliedSetup, readActiveSetup } = await import("../../../src/setups/io");
    const { applyIntents } = await import("@raceiq/backend-core/setups/rules/engine");

    // Same read path loadActiveExperimentContext uses for an ac-evo session whose
    // base is a .carsetup file.
    const guarded = await resolveGuardedSetupFile("ac-evo", join(setupsDir, "Default-12312.carsetup"));
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;

    // Same mutation path apply_changes uses: an intent against the "ac-evo"
    // rules table (Brake Bias is a real knob patchCarSetup can write).
    const { setup, applied } = applyIntents("ac-evo", guarded.setup, [
      { component: "Brake Bias", direction: "increase", magnitude: "small", reason: "more front bite" },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.component).toBe("Brake Bias");

    // Same write path apply_changes uses to create the new branch's file.
    const written = await writeAppliedSetup("ac-evo", {
      baseDir: guarded.baseDir,
      realPath: guarded.realPath,
      setup,
      stem: "integration-v2",
    });

    // A real file was written (not degraded to advisory) with the applied change.
    expect(written.setupPath).not.toBeNull();
    expect(written.setupSnapshot).toBeNull();
    const rewritten = await readCarSetupFile(written.setupPath!);
    expect(rewritten).not.toBeNull();
    expect(carSetupToKnobValues(rewritten!).brakeBias).toBeCloseTo(applied[0]!.to, 2);

    // readActiveSetup on the new node (setupPath set, no snapshot) reads it
    // back the normal file-adapter way — the branch is fully usable.
    const readBack = await readActiveSetup("ac-evo", { setupPath: written.setupPath, setupSnapshot: null });
    expect(readBack.ok).toBe(true);
  });
});
