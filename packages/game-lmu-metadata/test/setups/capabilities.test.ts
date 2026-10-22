import { describe, expect, test } from "bun:test";
import type { SvmDocument, SvmSetting } from "../../src/setups/svm";
import { getSvmCapabilities, getSvmFieldAccess } from "../../src/setups/capabilities";

function doc(carId: string | null, carName: string, className: SvmDocument["className"], pairs: readonly [string, string][] = []): SvmDocument {
  const settings = new Map<string, SvmSetting>();
  for (const [id, display] of pairs) {
    const [section, key] = id.split(".");
    settings.set(id, { id, section: section!, key: key!, index: 1, display, line: 1, indexStart: 0, indexEnd: 1, displayStart: 2, displayEnd: 3, markerStart: null, markerEnd: null, markerDelta: 0 });
  }
  return { originalBytes: new Uint8Array(), lines: [], vehicleClass: carName, className, carName, carId, identityWarning: null, symmetric: null, settings };
}

const HYBRID_FIELDS: readonly [string, string][] = [
  ["ENGINE.RegenerationMapSetting", "1"],
  ["ENGINE.ElectricMotorMapSetting", "1"],
  ["DRIVELINE.FrontDiffPowerSetting", "1"],
];

describe("LMU SVM capabilities", () => {
  test("catalog IDs gate architecture and hypercar controls", () => {
    const lmdh = getSvmCapabilities(doc("porsche_963_2023", "Porsche 963", "Hypercar"));
    expect(lmdh).toEqual({ architecture: "lmdh", hybrid: true, frontDrive: false, abs: false });
    expect(getSvmFieldAccess(doc("porsche_963_2023", "Porsche 963", "Hypercar", HYBRID_FIELDS), "ENGINE.RegenerationMapSetting").editable).toBe(true);
    expect(getSvmFieldAccess(doc("porsche_963_2023", "Porsche 963", "Hypercar", HYBRID_FIELDS), "DRIVELINE.FrontDiffPowerSetting")).toEqual({ editable: false, reason: "Field requires front-wheel drive" });
    const ferrari = doc("ferrari_499p_2023", "Ferrari 499P", "Hypercar", HYBRID_FIELDS);
    expect(getSvmCapabilities(ferrari).architecture).toBe("lmh-front-hybrid");
    expect(getSvmFieldAccess(ferrari, "DRIVELINE.FrontDiffPowerSetting").editable).toBe(true);
    const valkyrie = doc("aston_martin_valkyrie_2025", "Aston Martin Valkyrie", "Hypercar", HYBRID_FIELDS);
    expect(getSvmCapabilities(valkyrie).architecture).toBe("lmh-non-hybrid");
    expect(getSvmFieldAccess(valkyrie, "ENGINE.RegenerationMapSetting").editable).toBe(false);
  });

  test("distinctive aliases are class-gated; unknown hypercars stay unknown", () => {
    expect(getSvmCapabilities(doc(null, "BMW M Hybrid V8", "Hypercar")).architecture).toBe("lmdh");
    expect(getSvmCapabilities(doc(null, "Toyota GR010", "Hypercar")).architecture).toBe("lmh-front-hybrid");
    expect(getSvmCapabilities(doc(null, "BMW M Hybrid V8", "GT3")).architecture).toBe("unknown");
    expect(getSvmCapabilities(doc(null, "Unknown Prototype", "Hypercar")).hybrid).toBeNull();
  });

  test("ABS class knowledge distinguishes GT3, GTE, and unknown class", () => {
    expect(getSvmCapabilities(doc(null, "GT car", "GT3")).abs).toBe(true);
    expect(getSvmCapabilities(doc(null, "GTE car", "GTE")).abs).toBe(false);
    expect(getSvmCapabilities(doc(null, "Unknown", null)).abs).toBeNull();
  });

  test("field access keeps GT3 virtual energy and Detached ARBs editable", () => {
    const gt3 = doc("911gt3r_2024", "Porsche 911 GT3 R", "GT3", [
      ["GENERAL.VirtualEnergySetting", "0"],
      ["ENGINE.RegenerationMapSetting", "0"],
      ["DRIVELINE.FrontDiffPowerSetting", "0"],
      ["SUSPENSION.FrontAntiSwaySetting", "Detached"],
      ["SUSPENSION.RearAntiSwaySetting", "Fixed"],
      ["GENERAL.FuelCapacitySetting", "Fuel carried"],
    ]);
    expect(getSvmFieldAccess(gt3, "GENERAL.VirtualEnergySetting").editable).toBe(true);
    expect(getSvmFieldAccess(gt3, "ENGINE.RegenerationMapSetting").editable).toBe(false);
    expect(getSvmFieldAccess(gt3, "DRIVELINE.FrontDiffPowerSetting").editable).toBe(false);
    expect(getSvmFieldAccess(gt3, "SUSPENSION.FrontAntiSwaySetting").editable).toBe(true);
    expect(getSvmFieldAccess(gt3, "SUSPENSION.RearAntiSwaySetting").editable).toBe(false);
    expect(getSvmFieldAccess(gt3, "GENERAL.FuelCapacitySetting").editable).toBe(false);
  });

  test("mapped and unknown fields receive precise access reasons", () => {
    const unknown = doc(null, "Mystery Hypercar", "Hypercar", HYBRID_FIELDS);
    expect(getSvmFieldAccess(unknown, "ENGINE.RegenerationMapSetting")).toEqual({ editable: false, reason: "Hybrid capability is unknown" });
    expect(getSvmFieldAccess(unknown, "DRIVELINE.FrontDiffPowerSetting")).toEqual({ editable: false, reason: "Front-drive capability is unknown" });
    expect(getSvmFieldAccess(doc(null, "Car", "GT3"), "ENGINE.RegenerationMapSetting")).toEqual({ editable: false, reason: "Field is not a mapped setting" });
  });
});
