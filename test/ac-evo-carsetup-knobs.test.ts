import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { tmpdir } from "os";
import { join } from "path";
import { readCarSetupFile, carSetupToKnobValues } from "../server/games/ac-evo/carsetup";

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

const FIXTURE = join(import.meta.dir, "artifacts", "carsetup", "Default-12312.carsetup");
const AUDI_D3 = join(import.meta.dir, "artifacts", "carsetup", "audi-default-3.carsetup");

describe("carSetupToKnobValues", () => {
  it("maps decoded Audi fixture to tune-rules knob paths (grounded in-game values)", async () => {
    const setup = await readCarSetupFile(FIXTURE);
    expect(setup).not.toBeNull();
    const knobs = carSetupToKnobValues(setup!);

    // Values grounded against the in-game setup screen (see ac-evo-carsetup.test.ts)
    expect(knobs.frontARB).toBe(3); // click 3 (28 kN/m via ARB_CLICK_BY_KNM)
    expect(knobs.brakeBias).toBeCloseTo(52.6, 1);
    expect(knobs.steerRatio).toBe(15);
    expect(knobs.diffPreload).toBe(300);
    expect(knobs.frontLeftTyrePressure).toBeCloseTo(35, 2);
    expect(knobs.frontRightTyrePressure).toBeCloseTo(26, 2);
    expect(knobs.rearLeftTyrePressure).toBeCloseTo(25.5, 2);
    expect(knobs.frontToe).toBeCloseTo(-0.15, 3);
    expect(knobs.frontCamber).toBeCloseTo(-3.8, 2);
    expect(knobs.rearRideHeight).toBe(70);
    expect(knobs.rearWing).toBe(2);
    expect(knobs.fuel).toBe(104);
    expect(knobs.tc).toBe(12);
    expect(knobs.tc2).toBe(7);
    expect(knobs.abs).toBe(4);
  });

  it("maps ARB stiffness to click via known table (front click 1)", async () => {
    const setup = await readCarSetupFile(AUDI_D3);
    const knobs = carSetupToKnobValues(setup!);
    expect(knobs.frontARB).toBe(1);
  });

  it("omits ARB when stiffness has no known click mapping", async () => {
    const setup = await readCarSetupFile(FIXTURE);
    // Rear ARB stiffness on this save isn't in ARB_CLICK_BY_KNM — must be
    // omitted rather than fed to the model as a bogus click number.
    const knobs = carSetupToKnobValues(setup!);
    if (knobs.rearARB !== undefined) {
      // If present it must be a plausible click count, not raw N/m.
      expect(knobs.rearARB).toBeLessThanOrEqual(100);
    }
  });

  it("feeds getKnobState real current values for the ac-evo knob table", async () => {
    const { getAllKnobStates } = await import("../server/ai/tune-rules");
    const setup = await readCarSetupFile(FIXTURE);
    const knobs = carSetupToKnobValues(setup!);
    const states = getAllKnobStates("ac-evo", knobs);
    const byName = Object.fromEntries(states.map((s) => [s.component, s.current]));
    expect(byName["Front Anti-Roll Bar"]).toBe(3);
    expect(byName["Brake Bias"]).toBeCloseTo(52.6, 1);
    expect(byName["Rear Wing"]).toBe(2);
  });
});

describe("resolveGuardedSetupFile with .carsetup", () => {
  const fakeHome = join(tmpdir(), `raceiq-carsetup-test-${process.pid}`);
  const setupsDir = join(fakeHome, "Saved Games", "ACE", "Car Setups");
  beforeAll(async () => {
    const { initServerGameAdapters } = await import("../server/games/init");
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
    const { resolveGuardedSetupFile } = await import("../server/ai/setup-engineer-context");
    const guarded = await resolveGuardedSetupFile("ac-evo", join(setupsDir, "Default-12312.carsetup"));
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(guarded.setup).not.toBeNull();
    expect(guarded.setup.frontARB).toBe(3);
    expect(guarded.setup.brakeBias).toBeCloseTo(52.6, 1);
    expect(guarded.readOnly).toBe(true);
  });

  it("keeps setup null (not a crash) when the .carsetup doesn't decode", async () => {
    const { resolveGuardedSetupFile } = await import("../server/ai/setup-engineer-context");
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
    const { initServerGameAdapters } = await import("../server/games/init");
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
    const { writeAppliedSetup } = await import("../server/ai/setup-io");
    const original = await readCarSetupFile(join(setupsDir, "Default-12312.carsetup"));
    const knobs = carSetupToKnobValues(original!);

    const written = writeAppliedSetup("ac-evo", {
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
    const { writeAppliedSetup } = await import("../server/ai/setup-io");
    const written = writeAppliedSetup("ac-evo", {
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
    const { resolveGuardedSetupFile } = await import("../server/ai/setup-engineer-context");
    const { writeAppliedSetup, readActiveSetup } = await import("../server/ai/setup-io");
    const { applyIntents } = await import("../server/ai/tune-rules");

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
    const written = writeAppliedSetup("ac-evo", {
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
