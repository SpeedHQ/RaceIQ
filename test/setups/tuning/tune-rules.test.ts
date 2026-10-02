import { describe, expect, test } from "bun:test";
import { applyIntents } from "../../../server/setups/rules/engine";
import { knownComponents } from "../../../server/setups/rules/catalog";
import type { TuneIntent } from "../../../server/ai/schemas";

function intent(component: string, direction: TuneIntent["direction"], magnitude: TuneIntent["magnitude"] = "medium"): TuneIntent {
  return { component, direction, magnitude, reason: "test" };
}

function baseAccSetup() {
  return {
    basicSetup: {
      tyres: { tyrePressure: [26, 26, 26, 26] },
    },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

describe("applyIntents — multi-path FieldDef (ride height, dampers, diff preload)", () => {
  test("Front Ride Height moves both front indices together, clamped step, one AppliedChange", () => {
    const setup = baseAccSetup();
    const result = applyIntents("acc", setup, [intent("Front Ride Height", "increase", "medium")]);

    expect(result.applied).toHaveLength(1);
    const change = result.applied[0]!;
    expect(change.component).toBe("Front Ride Height");
    expect(change.paths).toEqual([
      "advancedSetup.aeroBalance.rideHeight.0",
      "advancedSetup.aeroBalance.rideHeight.1",
    ]);
    expect(change.from).toBe(65);
    expect(change.to).toBe(67); // medium step = 2
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[0]).toBe(67);
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[1]).toBe(67);
    // Rear pair untouched
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[2]).toBe(75);
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[3]).toBe(75);
    expect(result.skipped).toHaveLength(0);
  });

  test("Rear Ride Height decrease moves both rear indices together", () => {
    const setup = baseAccSetup();
    const result = applyIntents("acc", setup, [intent("Rear Ride Height", "decrease", "small")]);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.from).toBe(75);
    expect(result.applied[0]!.to).toBe(74);
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[2]).toBe(74);
    expect(result.setup.advancedSetup.aeroBalance.rideHeight[3]).toBe(74);
  });

  test("Front Bump and Front Rebound each move their own axle pair independently", () => {
    const setup = baseAccSetup();
    const result = applyIntents("acc", setup, [
      intent("Front Bump", "increase", "large"),
      intent("Front Rebound", "decrease", "small"),
    ]);

    expect(result.applied).toHaveLength(2);
    expect(result.setup.advancedSetup.dampers.bumpSlow).toEqual([12, 12, 8, 8]);
    expect(result.setup.advancedSetup.dampers.reboundSlow).toEqual([7, 7, 8, 8]);
  });

  test("Rear Ride Height clamps at max and reports no-op at limit", () => {
    const setup = baseAccSetup();
    setup.advancedSetup.aeroBalance.rideHeight = [65, 65, 109, 109];
    const first = applyIntents("acc", setup, [intent("Rear Ride Height", "increase", "large")]);
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]!.to).toBe(110); // clamped to max

    const atLimit = applyIntents("acc", first.setup, [intent("Rear Ride Height", "increase", "large")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped).toHaveLength(1);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("single-path knob (Diff Preload) still works with paths array of length 1", () => {
    const setup = baseAccSetup();
    const result = applyIntents("acc", setup, [intent("Diff Preload", "increase", "medium")]);

    expect(result.applied).toHaveLength(1);
    const change = result.applied[0]!;
    expect(change.paths).toEqual(["advancedSetup.drivetrain.preload"]);
    expect(change.from).toBe(40);
    expect(change.to).toBe(42);
    expect(result.setup.advancedSetup.drivetrain.preload).toBe(42);
  });

  test("missing one path in a pair skips the whole knob (no partial apply)", () => {
    const setup = baseAccSetup();
    // Simulate a malformed setup where only one ride-height index exists.
    setup.advancedSetup.aeroBalance.rideHeight = [65];
    const result = applyIntents("acc", setup, [intent("Front Ride Height", "increase", "medium")]);

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/Missing\/invalid value/);
    // Untouched — no partial write
    expect(result.setup.advancedSetup.aeroBalance.rideHeight).toEqual([65]);
  });

  test("existing knobs (ARB, tyre pressure) behave unchanged", () => {
    const setup = baseAccSetup();
    const result = applyIntents("acc", setup, [
      intent("Front Anti-Roll Bar", "decrease", "small"),
      intent("Front Tyre Pressure FL", "increase", "medium"),
    ]);

    expect(result.applied).toHaveLength(2);
    const arb = result.applied.find((c) => c.component === "Front Anti-Roll Bar")!;
    expect(arb.paths).toEqual(["advancedSetup.mechanicalBalance.aRBFront"]);
    expect(arb.from).toBe(5);
    expect(arb.to).toBe(4);

    const fl = result.applied.find((c) => c.component === "Front Tyre Pressure FL")!;
    expect(fl.paths).toEqual(["basicSetup.tyres.tyrePressure.0"]);
    expect(fl.from).toBe(26);
    expect(fl.to).toBe(28);
  });

  test("knownComponents(acc) includes the new knobs", () => {
    const components = knownComponents("acc");
    expect(components).toContain("Front Ride Height");
    expect(components).toContain("Rear Ride Height");
    expect(components).toContain("Front Bump");
    expect(components).toContain("Rear Bump");
    expect(components).toContain("Front Rebound");
    expect(components).toContain("Rear Rebound");
    expect(components).toContain("Diff Preload");
  });

  test("ac-evo table does not include ride height / dampers (unverified shape)", () => {
    const components = knownComponents("ac-evo");
    expect(components).not.toContain("Front Ride Height");
    expect(components).not.toContain("Front Bump");
  });
});

// ── Per-car narrowing (AC Evo setup-ranges.json, plan Phase 3) ─────────────
// Fixture cars pulled from the real extracted data:
//  - abarth_695_biposto: frontWing/rearWing are null (no wings on car),
//    brakeBias 0–100 step 1.
//  - ferrari_296_gt3: brakeBias 50–80 step 0.2, rearWing −2–10, frontWing null.
function baseEvoSnapshot() {
  return { frontARB: 5, rearARB: 5, brakeBias: 55, frontWing: 3, rearWing: 4 };
}

describe("applyIntents / knownComponents — per-car narrowing (ac-evo)", () => {
  test("null component (Abarth wings) is dropped from knownComponents", () => {
    const components = knownComponents("ac-evo", "abarth_695_biposto");
    expect(components).not.toContain("Front Wing");
    expect(components).not.toContain("Rear Wing");
    // Abarth street car has no adjustable ARBs either (frontARB/rearARB null in setup-ranges.json)
    expect(components).not.toContain("Front Anti-Roll Bar");
    // Fields with real per-car data keep their entries
    expect(components).toContain("Brake Bias");
  });

  test("null component is rejected on apply (Abarth Rear Wing)", () => {
    const result = applyIntents("ac-evo", baseEvoSnapshot(), [intent("Rear Wing", "increase")], "abarth_695_biposto");
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/Unknown component/);
    expect(result.setup.rearWing).toBe(4); // untouched
  });

  test("per-car clamps replace globals (Ferrari 296 GT3 brake bias, step 0.2)", () => {
    const setup = baseEvoSnapshot();
    setup.brakeBias = 79.9;
    const result = applyIntents("ac-evo", setup, [intent("Brake Bias", "increase", "large")], "ferrari_296_gt3");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.to).toBe(80); // clamped to per-car max, not global 70
  });

  test("per-car step sizes are used (Ferrari brake bias medium = 0.2×2)", () => {
    const result = applyIntents("ac-evo", baseEvoSnapshot(), [intent("Brake Bias", "increase", "medium")], "ferrari_296_gt3");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.to).toBeCloseTo(55.4, 5);
  });

  test("per-car min can go below the global floor (Ferrari rear wing −2)", () => {
    const setup = baseEvoSnapshot();
    setup.rearWing = -1;
    const result = applyIntents("ac-evo", setup, [intent("Rear Wing", "decrease", "small")], "ferrari_296_gt3");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.to).toBe(-2); // global min is 0 — per-car allows −2
  });

  test("unknown car falls back to the per-game global table", () => {
    const components = knownComponents("ac-evo", "not_a_real_car");
    expect(components).toContain("Rear Wing");
    const result = applyIntents("ac-evo", baseEvoSnapshot(), [intent("Brake Bias", "increase", "large")], "not_a_real_car");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.to).toBe(57); // global step {large: 2}
  });

  test("no carModel keeps existing global behaviour", () => {
    const result = applyIntents("ac-evo", baseEvoSnapshot(), [intent("Front Wing", "increase", "small")]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.to).toBe(4);
  });

  test("acc carModel is ignored (no per-car data — encrypted game files)", () => {
    const components = knownComponents("acc", "ferrari_296_gt3");
    expect(components).toEqual(knownComponents("acc"));
  });
});
