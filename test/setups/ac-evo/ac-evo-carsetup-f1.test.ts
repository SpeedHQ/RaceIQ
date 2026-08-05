import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeCarSetup } from "../../../server/games/ac-evo/carsetup";
import { parseCarSetup } from "../../../server/games/ac-evo/carsetup-wire";

// Ferrari SF25, Brands Hatch. Two saves of the same setup:
//  - "F1 default"   — ERS deployment map 4 (UI)
//  - "F1 default 2" — identical except ERS deployment map 1 (UI)
const FIXTURE = join(import.meta.dir, "..", "..", "artifacts", "carsetup", "F1 default.carsetup");
const FIXTURE_2 = join(import.meta.dir, "..", "..", "artifacts", "carsetup", "F1 default 2.carsetup");

const sectionRows = (file: string, title: string): Record<string, string> => {
  const setup = parseCarSetup(readFileSync(file))!;
  const sections = summarizeCarSetup(setup);
  return Object.fromEntries(sections.find((s) => s.title === title)!.rows.map((r) => [r.label, r.value]));
};

describe("ac-evo carsetup parser (F1 / Ferrari SF25)", () => {
  it("extracts SF25 preset id", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    expect(setup.presetId).toBe("ks_ferrari_sf_25_preset_sf25_mech_1_preset_sf25_visual_1");
  });

  // Grounded against in-game values (F1 default):
  it("front-left corner matches in-game values", () => {
    const fl = sectionRows(FIXTURE, "Front left");
    expect(fl["Tyre pressure"]).toBe("15.1 psi");
    expect(fl.Toe).toBe("-0.11");
    expect(fl.Camber).toBe("-1.85°");
    expect(fl["Slow bump"]).toBe("12");
    expect(fl["Slow rebound"]).toBe("7");
    // NOTE: "Caster? (#5)" drifts between saves of an unchanged setup — noisy field, not asserted.
  });

  it("mechanical & brakes match in-game values", () => {
    const front = sectionRows(FIXTURE, "Front");
    const rear = sectionRows(FIXTURE, "Rear");
    const mech = sectionRows(FIXTURE, "Mechanical & brakes");
    expect(front["Brake bias"]).toBe("59.9% front");
    expect(rear["Differential preload"]).toBe("75 Nm");
    expect(mech["Diff coast"]).toBe("0.33");
    expect(mech["Diff power"]).toBe("0.31");
    // ARB shown in UI as clicks (front 4 / rear 7); file stores stiffness in N/m
    // and the SF25 values don't match a known click table — raw kN/m shown.
    expect(front["Anti-roll bar"]).toBe("66 kN/m");
    expect(rear["Anti-roll bar"]).toBe("26 kN/m");
  });

  it("electronics match in-game values (ERS fields intentionally unmapped)", () => {
    // ERS excluded for now — encoding unclear. Observed (see ELECTRONICS_GUESSES notes):
    //   #8 tracks UI deploy map 0-indexed (UI 4 → raw 3; UI 1 → absent), BUT switching
    //   heat charging deploy→charge also wiped #8 and set #9 40→0.01 while #11 stayed 2.
    //   So #11 is not heat mode, and #8/#9 semantics need in-game verification.
    const elec = sectionRows(FIXTURE, "Electronics");
    expect(elec["Engine map"]).toBe("2");
    expect(elec["Telemetry laps"]).toBe("15");
    // ERS fields stay hidden until mapped (unlabeled wire fields are not shown).
    expect(elec["ERS deployment map"]).toBeUndefined();
    expect(elec["#8"]).toBeUndefined();

    // Same setup saved with UI deploy map 1: #8 absent, everything else labeled identical.
    const elec2 = sectionRows(FIXTURE_2, "Electronics");
    expect(elec2["#8"]).toBeUndefined();
    expect(elec2["Engine map"]).toBe("2");
  });

  it("aero & ride height match in-game values", () => {
    const aero = sectionRows(FIXTURE, "Aero & ride height");
    expect(aero["Front ride height"]).toBe("45 mm");
    expect(aero["Rear ride height"]).toBe("69 mm");
    expect(aero["Front wing"]).toBe("7");
    expect(aero["Rear wing"]).toBe("18");
  });

  it("fuel matches in-game value", () => {
    expect(sectionRows(FIXTURE, "Fuel & strategy")["Fuel load"]).toBe("98 L");
  });
});
