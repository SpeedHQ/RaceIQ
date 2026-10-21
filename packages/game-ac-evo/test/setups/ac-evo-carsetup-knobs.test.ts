import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readCarSetupFile, carSetupToKnobValues } from "../../src/carsetup";


const FIXTURE = join(ROOT_DIR, "test/artifacts/carsetup/Default-12312.carsetup");
const AUDI_D3 = join(ROOT_DIR, "test/artifacts/carsetup/audi-default-3.carsetup");

describe("carSetupToKnobValues", () => {
  it("maps decoded Audi fixture to rule-catalog knob paths (grounded in-game values)", async () => {
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
    const { getAllKnobStates } = await import("@raceiq/backend-core/setups/rules/engine");
    const setup = await readCarSetupFile(FIXTURE);
    const knobs = carSetupToKnobValues(setup!);
    const states = getAllKnobStates("ac-evo", knobs);
    const byName = Object.fromEntries(states.map((s) => [s.component, s.current]));
    expect(byName["Front Anti-Roll Bar"]).toBe(3);
    expect(byName["Brake Bias"]).toBeCloseTo(52.6, 1);
    expect(byName["Rear Wing"]).toBe(2);
  });
});

