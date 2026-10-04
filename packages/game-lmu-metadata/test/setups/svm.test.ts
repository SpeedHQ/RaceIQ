import { describe, expect, test } from "bun:test";
import { diffSVM, parseSVM, svmField, writeSVM } from "../../src/setups/svm";

const header = 'VehicleClassSetting="BMW M Hybrid V8 2023 Hypercar"';
function fixture(extra = "", finalNewline = true): Uint8Array {
  const text = `${header}\r\n//VEH=Installed\\Vehicles\\BMW_M_Hybrid_V8_2023\\BMW_M_Hybrid_V8_2023.VEH\n[GENERAL]\r\nSymmetric=1\nFuelSetting=3//Fuel\r\n[REARWING]\nRWSetting=6//1.4 deg\r\n[CONTROLS]\nSteerLockSetting=5//Wheel 180°\r\n[DRIVELINE]\nFrontDiffPowerSetting=0//Fixed\n[ENGINE]\nRegenerationMapSetting=2//Regen\n[FRONTLEFT]\nSpringSetting=4//1.0\n[FRONTRIGHT]\nSpringSetting=5//1.1\n[SUSPENSION]\nFront3rdSpringSetting=8//3rd ${extra}`;
  const raw = new TextEncoder().encode(text);
  // Replace UTF-8 degree symbol with Windows-1252 byte to exercise raw-span preservation.
  const degreeUtf8 = new Uint8Array([0xc2, 0xb0]);
  const at = raw.findIndex((v, i) => v === degreeUtf8[0] && raw[i + 1] === degreeUtf8[1]);
  const cp = new Uint8Array(raw.length - 1);
  cp.set(raw.subarray(0, at)); cp[at] = 0xb0; cp.set(raw.subarray(at + 2), at + 1);
  const withFinal = finalNewline ? new Uint8Array([...cp, 10]) : cp;
  return withFinal;
}
function parsed(bytes = fixture()) {
  const result = parseSVM(bytes);
  if (!result.ok) throw new Error(`${result.error} at ${result.line}`);
  return result.document;
}
describe("SVM codec", () => {
  test("parses identity, integer indices, labels and preserves original bytes on empty write", () => {
    const bytes = fixture();
    const doc = parsed(bytes);
    expect(doc.className).toBe("Hypercar");
    expect(doc.carId).toBe("bmw_m_hybrid_v8_2023");
    expect(doc.symmetric).toBe(1);
    expect(svmField(doc, "rearwing", "RWSetting")?.index).toBe(6);
    expect(svmField(doc, "REARWING", "RWSetting")?.display).toBe("1.4 deg");
    expect([...writeSVM(doc, [])]).toEqual([...bytes]);
  });
  test("retains CP1252 label bytes while writing click marker", () => {
    const doc = parsed();
    const setting = svmField(doc, "CONTROLS", "SteerLockSetting")!;
    const output = writeSVM(doc, [{ id: setting.id, delta: 1 }]);
    const text = [...output].map((v) => String.fromCharCode(v)).join("");
    expect(text).toContain("Wheel 180\xb0 (edited, 1 click up)");
    expect(text).not.toContain("180\xc2\xb0");
    const reparsed = parseSVM(output);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(svmField(reparsed.document, "CONTROLS", "SteerLockSetting")?.display).toBe("Wheel 180°");
  });
  test("applies only mapped editable edits and rejects invalid edit list atomically", () => {
    const doc = parsed();
    expect(() => writeSVM(doc, [{ id: "REARWING.RWSetting", delta: 1 }, { id: "FRONTLEFT.SpringSetting", delta: -99 }])).toThrow();
    expect(() => writeSVM(doc, [{ id: "DRIVELINE.FrontDiffPowerSetting", delta: 1 }])).toThrow();
    const output = writeSVM(doc, [{ id: "REARWING.RWSetting", delta: 1 }]);
    expect(new TextDecoder("windows-1252").decode(output)).toContain("RWSetting=7//1.4 deg (edited, 1 click up)");
    const reparsed = parseSVM(output);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      const second = writeSVM(reparsed.document, [{ id: "REARWING.RWSetting", delta: 2 }]);
      expect(new TextDecoder("windows-1252").decode(second)).toContain("RWSetting=9//1.4 deg (edited, 3 clicks up)");
    }
  });
  test("diff reports changed, added, removed and unknown numeric fields", () => {
    const a = parsed();
    const changed = fixture().slice();
    const source = new TextDecoder("windows-1252").decode(changed).replace("RWSetting=6", "RWSetting=7").replace("FuelSetting=3", "FuelSetting=4");
    const b = parsed(new TextEncoder().encode(source));
    expect(diffSVM(a, b).map((entry) => [entry.id, entry.kind])).toContainEqual(["REARWING.RWSetting", "changed"]);
    expect(diffSVM(a, b).map((entry) => [entry.id, entry.kind])).toContainEqual(["GENERAL.FuelSetting", "changed"]);
  });
  test("rejects malformed, unsafe, duplicate, binary, headerless and arbitrary files", () => {
    for (const body of ["[X]\nASetting=--1//a", "[X]\nASetting=2junk//a", "[X]\nASetting=9007199254740992//a", "[X]\nASetting=1//a\nASetting=2//b", "arbitrary text"]) {
      expect(parseSVM(new TextEncoder().encode(`${header}\n${body}`)).ok).toBe(false);
    }
    expect(parseSVM(new Uint8Array([0, 0xd8, 0, 0]))).toMatchObject({ ok: false });
    expect(parseSVM(new TextEncoder().encode("[X]\nASetting=1//x"))).toMatchObject({ ok: false });
  });
  test("does not treat label-only difference as numeric setup change", () => {
    const a = parsed();
    const b = parsed(new TextEncoder().encode(new TextDecoder("windows-1252").decode(fixture()).replace("1.4 deg", "1.5 deg")));
    expect(diffSVM(a, b)).toEqual([]);
  });
  test("BOM, whitespace, tuple headers, unknown lines and mixed terminators survive edits", () => {
    const source = new TextEncoder().encode('\uFEFFVehicleClassSetting = "WEC2025 Hypercar BMW_M_Hybrid_V8"\r\nUpgradeSetting=(1, 2, 3)\n[rearwing]\r\n  RWSetting = +6 // 1.4 deg  \nUnknown = keep this\r\n[X]\nExtraSetting=8//opaque');
    const doc = parsed(source);
    const output = writeSVM(doc, [{ id: "REARWING.RWSetting", delta: 1 }]);
    const expected = new TextEncoder().encode(new TextDecoder().decode(source).replace('+6', '7').replace(' 1.4 deg  ', ' 1.4 deg   (edited, 1 click up)'));
    // TextDecoder removes BOM; expected output must retain it.
    expect([...output]).toEqual([0xef, 0xbb, 0xbf, ...expected]);
    expect(doc.carName).toBe("BMW M Hybrid V8");
    expect(doc.settings.get("X.ExtraSetting")?.index).toBe(8);
    expect([...doc.originalBytes]).toEqual([...source]);
  });
  test("ARB detach and reconnect use honest special labels", () => {
    const doc = parsed(new TextEncoder().encode(`${header}\n[SUSPENSION]\nFrontAntiSwaySetting=1//P1`));
    const detached = parsed(writeSVM(doc, [{ id: "SUSPENSION.FrontAntiSwaySetting", delta: -1 }]));
    expect(detached.settings.get("SUSPENSION.FrontAntiSwaySetting")?.display).toBe("Detached");
    expect(new TextDecoder().decode(writeSVM(detached, [{ id: "SUSPENSION.FrontAntiSwaySetting", delta: 1 }]))).toContain("=1//Connected (edited, 1 click up)");
  });
  test("equal per-corner clicks preserve offsets and never edit third element", () => {
    const source = parsed();
    const output = parsed(writeSVM(source, [{ id: "FRONTLEFT.SpringSetting", delta: 1 }, { id: "FRONTRIGHT.SpringSetting", delta: 1 }]));
    expect(output.settings.get("FRONTLEFT.SpringSetting")?.index).toBe(5);
    expect(output.settings.get("FRONTRIGHT.SpringSetting")?.index).toBe(6);
    expect(output.settings.get("SUSPENSION.Front3rdSpringSetting")?.index).toBe(8);
    const marked = parsed(writeSVM(source, [{ id: "REARWING.RWSetting", delta: 1 }]));
    expect([...writeSVM(marked, [{ id: "REARWING.RWSetting", delta: -1 }])]).toEqual([...source.originalBytes]);
  });
  test("diff union includes unknown added and removed keys in source order", () => {
    const a = parsed(new TextEncoder().encode(`${header}\n[REARWING]\nRWSetting=6//label\n[X]\nRemovedSetting=1//unknown`));
    const b = parsed(new TextEncoder().encode('VehicleClassSetting="GTE Unknown"\n[REARWING]\nRWSetting=7//other\n[X]\nAddedSetting=2//unknown'));
    expect(diffSVM(a, b)).toEqual([
      { id: "REARWING.RWSetting", kind: "changed", before: { index: 6, display: "label" }, after: { index: 7, display: "other" } },
      { id: "X.RemovedSetting", kind: "removed", before: { index: 1, display: "unknown" }, after: null },
      { id: "X.AddedSetting", kind: "added", before: null, after: { index: 2, display: "unknown" } },
    ]);
    expect(b.className).toBe("GTE");
  });
  test("unmapped-only input fails while mapped missing-display input remains readable", () => {
    expect(parseSVM(new TextEncoder().encode(`${header}\n[X]\nUnknownSetting=1//label`)).ok).toBe(false);
    const doc = parsed(new TextEncoder().encode(`${header}\n[REARWING]\nRWSetting=6`));
    expect(() => writeSVM(doc, [{ id: "REARWING.RWSetting", delta: 1 }])).toThrow();
    for (const delta of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => writeSVM(parsed(), [{ id: "REARWING.RWSetting", delta }])).toThrow();
    }
    expect(() => writeSVM(parsed(), [{ id: "REARWING.RWSetting", delta: 1 }, { id: "REARWING.RWSetting", delta: 1 }])).toThrow();
  });
  test("mixed label encodings decode individually and preserve each byte base", () => {
    const doc = parsed(fixture("\n[REARLEFT]\nSpringSetting=5//ressort réglé"));
    expect(doc.settings.get("REARLEFT.SpringSetting")?.display).toBe("ressort réglé");
    const output = writeSVM(doc, [{ id: "REARLEFT.SpringSetting", delta: 1 }, { id: "CONTROLS.SteerLockSetting", delta: 1 }]);
    expect(parsed(output).settings.get("REARLEFT.SpringSetting")?.display).toBe("ressort réglé");
    const cp = doc.settings.get("CONTROLS.SteerLockSetting")!;
    const originalBase = doc.originalBytes.slice(cp.displayStart!, cp.displayEnd!);
    const newSetting = parsed(output).settings.get(cp.id)!;
    expect([...output.slice(newSetting.displayStart!, newSetting.displayEnd!)]).toEqual([...originalBase]);
  });
  test("catalog class is canonical when known header omits class token", () => {
    const content = '//VEH=Installed\\Vehicles\\BMW_M_Hybrid_V8_2023\\BMW_M_Hybrid_V8_2023.VEH\nVehicleClassSetting="BMW_M_Hybrid_V8_2023"\n[REARWING]\nRWSetting=1//wing';
    expect(parsed(new TextEncoder().encode(content))).toMatchObject({ carId: "bmw_m_hybrid_v8_2023", className: "Hypercar" });
  });
  test("identity comment folder aliases outrank unresolved header, conflicts remain unknown", () => {
    const content = '//VEH=Installed\\Vehicles\\BMW_M_Hybrid_V8_2023\\unrecognized.VEH\nVehicleClassSetting="WEC2025 Hypercar Unknown"\n[REARWING]\nRWSetting=1//wing';
    expect(parsed(new TextEncoder().encode(content)).carId).toBe("bmw_m_hybrid_v8_2023");
    const conflict = parsed(new TextEncoder().encode(content.replace("Hypercar Unknown", "GTE Unknown")));
    expect(conflict.identityWarning).not.toBeNull();
    expect(conflict.carId).toBeNull();
    const bad = parseSVM(new TextEncoder().encode('VehicleClassSetting=not-quoted\n[REARWING]\nRWSetting=1//wing'));
    expect(bad).toMatchObject({ ok: false, line: 1 });
  });
});
