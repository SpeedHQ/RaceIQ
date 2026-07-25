import { describe, expect, test } from "bun:test";
import { applyIntents, knownComponents } from "../server/ai/tune-rules";
import type { TuneIntent } from "../server/ai/schemas";

function intent(component: string, direction: TuneIntent["direction"], magnitude: TuneIntent["magnitude"] = "medium"): TuneIntent {
  return { component, direction, magnitude, reason: "test" };
}

/** Flat F1CarSetup value model — mid-range values so both directions have room. */
function baseF1Setup() {
  return {
    frontWing: 25,
    rearWing: 25,
    onThrottle: 55,
    offThrottle: 55,
    frontCamber: -3,
    rearCamber: -1.5,
    frontToe: 0.1,
    rearToe: 0.17,
    frontSuspension: 20,
    rearSuspension: 20,
    frontAntiRollBar: 11,
    rearAntiRollBar: 11,
    frontRideHeight: 25,
    rearRideHeight: 50,
    brakePressure: 95,
    brakeBias: 55,
    engineBraking: 50,
    frontLeftTyrePressure: 26,
    frontRightTyrePressure: 26,
    rearLeftTyrePressure: 23.5,
    rearRightTyrePressure: 23.5,
    fuelLoad: 50,
  };
}

describe("applyIntents — f1-2025 (catalog-sourced ranges)", () => {
  test("knownComponents excludes engineBraking/fuelLoad (no catalog range)", () => {
    const components = knownComponents("f1-2025");
    expect(components.length).toBeGreaterThan(0);
    expect(components).not.toContain("Engine Braking");
    expect(components).not.toContain("Fuel Load");
  });

  test("Front Wing moves the right field within range", () => {
    const setup = baseF1Setup();
    const result = applyIntents("f1-2025", setup, [intent("Front Wing", "increase", "medium")]);

    expect(result.applied).toHaveLength(1);
    const change = result.applied[0]!;
    expect(change.component).toBe("Front Wing");
    expect(change.paths).toEqual(["frontWing"]);
    expect(change.from).toBe(25);
    expect(change.to).toBe(27); // medium step = 2
    expect(result.setup.frontWing).toBe(27);
    // untouched fields
    expect(result.setup.rearWing).toBe(25);
    expect(result.skipped).toHaveLength(0);
  });

  test("Rear Wing decrease moves only rearWing", () => {
    const setup = baseF1Setup();
    const result = applyIntents("f1-2025", setup, [intent("Rear Wing", "decrease", "small")]);
    expect(result.applied[0]!.to).toBe(24);
    expect(result.setup.rearWing).toBe(24);
    expect(result.setup.frontWing).toBe(25);
  });

  test("Front Wing clamps at max (50) and reports no-op at the limit", () => {
    const setup = baseF1Setup();
    setup.frontWing = 49;
    const first = applyIntents("f1-2025", setup, [intent("Front Wing", "increase", "large")]); // step 4
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]!.to).toBe(50); // clamped to max

    const atLimit = applyIntents("f1-2025", first.setup, [intent("Front Wing", "increase", "large")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped).toHaveLength(1);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("Front Anti-Roll Bar clamps at min (1)", () => {
    const setup = baseF1Setup();
    setup.frontAntiRollBar = 2;
    const first = applyIntents("f1-2025", setup, [intent("Front Anti-Roll Bar", "decrease", "large")]); // step 4
    expect(first.applied[0]!.to).toBe(1); // clamped to min

    const atLimit = applyIntents("f1-2025", first.setup, [intent("Front Anti-Roll Bar", "decrease", "small")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("Front Camber (decimal field) moves within its narrow catalog range and clamps", () => {
    const setup = baseF1Setup();
    setup.frontCamber = -2.6;
    const result = applyIntents("f1-2025", setup, [intent("Front Camber", "increase", "small")]); // step 0.1, max -2.5
    expect(result.applied[0]!.to).toBeCloseTo(-2.5);

    const atLimit = applyIntents("f1-2025", result.setup, [intent("Front Camber", "increase", "small")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("Brake Bias sources its range from the catalog's frontBrakeBias (50-60) but writes the packet's brakeBias path", () => {
    const setup = baseF1Setup();
    setup.brakeBias = 59;
    const result = applyIntents("f1-2025", setup, [intent("Brake Bias", "increase", "medium")]); // step 2, max 60
    expect(result.applied[0]!.paths).toEqual(["brakeBias"]);
    expect(result.applied[0]!.to).toBe(60); // clamped to max

    const atLimit = applyIntents("f1-2025", result.setup, [intent("Brake Bias", "increase", "small")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("Rear Left Tyre Pressure moves within range and clamps at min", () => {
    const setup = baseF1Setup();
    setup.rearLeftTyrePressure = 20.6;
    const result = applyIntents("f1-2025", setup, [intent("Rear Left Tyre Pressure", "decrease", "small")]); // step 0.1, min 20.5
    expect(result.applied[0]!.to).toBeCloseTo(20.5);

    const atLimit = applyIntents("f1-2025", result.setup, [intent("Rear Left Tyre Pressure", "decrease", "small")]);
    expect(atLimit.applied).toHaveLength(0);
    expect(atLimit.skipped[0]!.reason).toMatch(/clamp/i);
  });

  test("unknown component is skipped, not applied", () => {
    const setup = baseF1Setup();
    const result = applyIntents("f1-2025", setup, [intent("Fuel Load", "increase", "medium")]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/unknown/i);
  });
});
