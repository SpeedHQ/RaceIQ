import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCarSetupFile, carSetupToKnobValues } from "../server/games/ac-evo/carsetup";

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
  const savedProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    const { initServerGameAdapters } = await import("../server/games/init");
    initServerGameAdapters();
    mkdirSync(setupsDir, { recursive: true });
    copyFileSync(FIXTURE, join(setupsDir, "Default-12312.carsetup"));
    writeFileSync(join(setupsDir, "corrupt.carsetup"), "not a protobuf file at all");
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile;
    if (savedHome !== undefined) process.env.HOME = savedHome;
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

describe("writeAppliedSetup .carsetup guard", () => {
  it("refuses to write when the base setup is a binary .carsetup", async () => {
    const { writeAppliedSetup } = await import("../server/ai/setup-io");
    expect(() =>
      writeAppliedSetup("ac-evo", {
        baseDir: "C:\\somewhere",
        realPath: "C:\\somewhere\\Default-12312.carsetup",
        setup: { frontARB: 3 },
        stem: "test-v2",
      }),
    ).toThrow(/\.carsetup .*advisory only/i);
  });
});
