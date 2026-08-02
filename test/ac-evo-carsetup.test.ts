import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { formatCarSetup, readCarSetupFile } from "../server/games/ac-evo/carsetup";
import { parseCarSetup } from "../server/games/ac-evo/carsetup-wire";

const FIXTURE = join(import.meta.dir, "artifacts", "carsetup", "Default-12312.carsetup");

describe("ac-evo carsetup parser", () => {
  it("parses real .carsetup fixture", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE));
    expect(setup).not.toBeNull();
    expect(setup!.raw.length).toBeGreaterThan(0);
  });

  it("extracts preset id from field #9", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    expect(setup.presetId).toBe("ks_audi_r8_lms_gt3_evo_2_preset_r8gt3_mech_1_preset_r8gt3_visual_1");
  });

  it("decodes expected wire structure (per-corner blocks + floats)", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    // 4 per-corner spring blocks (field #2), 4 damper blocks (field #3), 4 alignment blocks (field #4)
    const corners = setup.raw.filter((f) => f.no === 2 && f.type === "message");
    const dampers = setup.raw.filter((f) => f.no === 3 && f.type === "message");
    const alignment = setup.raw.filter((f) => f.no === 4 && f.type === "message");
    expect(corners).toHaveLength(4);
    expect(dampers).toHaveLength(4);
    expect(alignment).toHaveLength(4);

    // Grounded against in-game values (Audi R8 GT3 Evo II, Brands Hatch, Default-12312):
    // front-left wheel rate 240000 N/m, front-right 220000, rear 280000
    const springRates = corners.map((c) => (c.type === "message" && c.fields[0]?.type === "float" ? c.fields[0].value : null));
    expect(springRates).toEqual([240000, 220000, 280000, 280000]);

    // Tyre pressures: front-left 35.0 psi (in-game), front-right 26.0, rear 25.5 (alignment block field #1)
    const pressures = alignment.map((a) => (a.type === "message" && a.fields[0]?.type === "float" ? a.fields[0].value : null));
    const expected = [35, 26, 25.5, 25.5];
    expect(pressures).toHaveLength(4);
    for (const [i, p] of pressures.entries()) {
      expect(p).not.toBeNull();
      expect(p!).toBeCloseTo(expected[i]!, 3);
    }
  });

  it("summary matches in-game values (grounded, Audi R8 GT3 Evo II)", async () => {
    const { summarizeCarSetup } = await import("../server/games/ac-evo/carsetup");
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    const sections = summarizeCarSetup(setup);
    const rows = (title: string) =>
      Object.fromEntries(sections.find((s) => s.title === title)!.rows.map((r) => [r.label, r.value]));

    const fl = rows("Front left");
    expect(fl["Tyre pressure"]).toBe("35 psi");
    expect(fl["Camber"]).toBe("-3.8°");
    expect(fl["Toe"]).toBe("-0.15");
    expect(fl["Wheel rate"]).toBe("240 kN/m");
    expect(fl["Packer rate"]).toBe("3500");
    expect(fl["Bumpstop rate"]).toBe("1500");
    expect(fl["Slow bump"]).toBe("6");
    expect(fl["Slow rebound"]).toBe("5");

    // ARB lives on the Front/Rear cards; click shown when stiffness matches
    // known Audi table (1→16, 2→22, 3→28 kN/m)
    const front = rows("Front");
    const rear = rows("Rear");
    expect(front["Anti-roll bar"]).toBe("3 (28 kN/m)");
    expect(rear["Anti-roll bar"]).toBeDefined();
    expect(front["Brake bias"]).toBe("52.6% front");
    expect(rear["Differential preload"]).toBe("300 Nm");
    expect(front["Steer ratio"]).toBe("15");

    const elec = rows("Electronics");
    expect(elec["TC"]).toBe("12");
    expect(elec["TC2"]).toBe("7");
    expect(elec["ABS"]).toBe("4");
    expect(elec["Telemetry laps"]).toBe("20");

    const aero = rows("Aero & ride height");
    expect(aero["Rear ride height"]).toBe("70 mm");
    expect(aero["Rear wing"]).toBe("2");

    expect(rows("Fuel & strategy")["Fuel load"]).toBe("104 L");
  });

  it("readCarSetupFile reads from disk", async () => {
    const setup = await readCarSetupFile(FIXTURE);
    expect(setup).not.toBeNull();
    expect(setup!.presetId).toContain("audi_r8_lms_gt3");
  });

  it("returns null for non-protobuf input", async () => {
    expect(parseCarSetup(Buffer.from("not a protobuf file at all"))).toBeNull();
    expect(await readCarSetupFile(join(import.meta.dir, "does-not-exist.carsetup"))).toBeNull();
  });

  it("ARB clicks map to stiffness (Audi front click 1 = 16 kN/m)", async () => {
    // Grounded: user set front ARB to click 1 (min) in game, rear stayed at
    // default 3, and saved as "default 3". Front must render click + kN/m.
    const setup = await readCarSetupFile(join(import.meta.dir, "artifacts", "carsetup", "audi-default-3.carsetup"));
    expect(setup).not.toBeNull();
    const { summarizeCarSetup } = await import("../server/games/ac-evo/carsetup");
    const sections = summarizeCarSetup(setup!);
    const rowsOf = (title: string) =>
      Object.fromEntries(sections.find((s) => s.title === title)!.rows.map((r) => [r.label, r.value]));
    expect(rowsOf("Front")["Anti-roll bar"]).toBe("1 (16 kN/m)");
    expect(rowsOf("Rear")["Anti-roll bar"]).toBeDefined();
  });

  it("formatCarSetup renders readable tree", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    const text = formatCarSetup(setup);
    expect(text).toContain("#2 {");
    expect(text).toContain("220000");
    expect(text).toContain("ks_audi_r8_lms_gt3_evo_2_preset");
  });
});
