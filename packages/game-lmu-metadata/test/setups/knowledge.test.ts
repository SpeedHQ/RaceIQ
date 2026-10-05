import { describe, expect, test } from "bun:test";
import type { SvmDocument } from "../../src/setups/svm";
import { parseSVM } from "../../src/setups/svm";
import { getParameterAdvice, getPresetAdvice, getSymptomAdvice } from "../../src/setups/knowledge";

function document(header: string): SvmDocument {
  const result = parseSVM(new TextEncoder().encode(`VehicleClassSetting="${header}"\n[GENERAL]\nVirtualEnergySetting=1//Energy\n[CONTROLS]\nBrakePressureSetting=5//Pedal force\n[ENGINE]\nRegenerationMapSetting=1//Regen\nElectricMotorMapSetting=1//Deploy\n[DRIVELINE]\nFrontDiffPowerSetting=1//Front diff`));
  if (!result.ok) throw new Error(result.error);
  return result.document;
}
function documentWithSetting(header: string, section: string, key: string, index: number): SvmDocument {
  const result = parseSVM(new TextEncoder().encode(`VehicleClassSetting="${header}"\n[GENERAL]\nVirtualEnergySetting=1//Energy\n[CONTROLS]\nBrakePressureSetting=5//Pedal force\n[ENGINE]\nRegenerationMapSetting=1//Regen\nElectricMotorMapSetting=1//Deploy\n[DRIVELINE]\nFrontDiffPowerSetting=1//Front diff\n[${section}]\n${key}=${index}//setting`));
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

describe("LMU setup knowledge", () => {

  test("hybrid, front-drive and no-ABS advice requires known matching capability", () => {
    const unknown = getPresetAdvice(document("Unrecognized Prototype 2026 Hypercar"));
    expect(unknown.find(({ item }) => item.id === "hybrid_brake")?.availability).toMatchObject({ available: false });
    expect(unknown.find(({ item }) => item.id === "brake_lock")?.availability.available).toBe(true);
    const gt3 = getPresetAdvice(document("Porsche_911_GT3_R_LMGT3 GT3"));
    expect(gt3.find(({ item }) => item.id === "brake_lock")?.availability).toMatchObject({ available: false, reason: expect.stringContaining("ABS") });
    const lmdh = getSymptomAdvice(document("BMW_M_Hybrid_V8_2023 Hypercar"));
    expect(lmdh.find(({ item }) => item.id === "entrySnap")?.item.causes.find(({ id }) => id === "regen")?.availability.available).toBe(true);
    expect(lmdh.find(({ item }) => item.id === "frontDiffEntry")?.availability.available).toBe(false);
    const frontHybrid = getParameterAdvice(document("Ferrari_499P Hypercar"));
    expect(frontHybrid.find(({ item }) => item.id === "frontDiff")?.availability.available).toBe(true);
    expect(frontHybrid.find(({ item }) => item.id === "regen")?.availability.available).toBe(true);
    const frontRegen = getSymptomAdvice(document("Ferrari_499P Hypercar")).find(({ item }) => item.id === "entrySnap")?.item.causes.find(({ id }) => id === "regen")?.availability;
    expect(frontRegen?.available).toBe(false);
    const nonHybrid = getParameterAdvice(document("Aston_Martin_Valkyrie Hypercar"));
    expect(nonHybrid.find(({ item }) => item.id === "regen")?.availability.available).toBe(false);
  });

  test.each([
    ["Porsche_911_GT3_R_LMGT3 GT3", false],
    ["Aston_Martin_Valkyrie Hypercar", false],
    ["Unrecognized Prototype 2026 Hypercar", false],
    ["BMW_M_Hybrid_V8_2023 Hypercar", true],
  ] as const)("fuel and NRG diagnosis remains usable for %s", (header, hybridAvailable) => {
    const advice = getSymptomAdvice(document(header)).find(({ item }) => item.id === "energyShort")!;
    expect(advice.availability).toEqual({ available: true, reason: null });
    for (const id of ["virtualEnergy", "fuelRatio"]) {
      expect(advice.item.causes.find((cause) => cause.id === id)?.availability).toEqual({ available: true, reason: null });
    }
    for (const id of ["motorMap", "regen"]) {
      expect(advice.item.causes.find((cause) => cause.id === id)?.availability.available).toBe(hybridAvailable);
    }
    expect(getPresetAdvice(document(header)).find(({ item }) => item.id === "energy_short")?.availability.available).toBe(hybridAvailable);
  });

  test("null selection withholds car-specific applicability", () => {
    for (const advice of [getParameterAdvice(null), getSymptomAdvice(null), getPresetAdvice(null)]) {
      expect(advice.every(({ availability }) => !availability.available && availability.reason)).toBe(true);
    }
  });

  test("no-ABS preset exposes advisory target without calculating clicks", () => {
    const brakeLock = getPresetAdvice(document("Unknown Prototype Hypercar")).find(({ item }) => item.id === "brake_lock");
    expect(brakeLock?.availability.available).toBe(true);
    expect(brakeLock?.item.targets[0]).toMatchObject({ delta: null, availability: { available: true, reason: null } });
  });
  test("preset availability rejects unsafe or negative click results", () => {
    const zeroDoc = documentWithSetting("Unknown Prototype Hypercar", "REARWING", "RWSetting", 0);
    const negative = getPresetAdvice(zeroDoc).find(({ item }) => item.id === "top_speed")?.item.targets[0];
    expect(negative?.availability.available).toBe(false);
    const unsafeDoc = documentWithSetting("Unknown Prototype Hypercar", "REARWING", "RWSetting", Number.MAX_SAFE_INTEGER);
    const unsafe = getPresetAdvice(unsafeDoc).find(({ item }) => item.id === "fast_over")?.item.targets[0];
    expect(unsafe?.availability.available).toBe(false);
    const safeDoc = documentWithSetting("Unknown Prototype Hypercar", "REARWING", "RWSetting", Number.MAX_SAFE_INTEGER - 1);
    const safe = getPresetAdvice(safeDoc).find(({ item }) => item.id === "fast_over")?.item.targets[0];
    expect(safe?.availability.available).toBe(true);
  });
});
