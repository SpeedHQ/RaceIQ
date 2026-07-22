import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { formatCarSetup, parseCarSetup, readCarSetupFile } from "../server/games/ac-evo/carsetup";

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

    // Front spring rate 220000 N/m, rear 280000 N/m
    const springRates = corners.map((c) => (c.type === "message" && c.fields[0]?.type === "float" ? c.fields[0].value : null));
    expect(springRates).toEqual([220000, 220000, 280000, 280000]);

    // Tyre pressures 26.0 front / 25.5 rear (alignment block field #1)
    const pressures = alignment.map((a) => (a.type === "message" && a.fields[0]?.type === "float" ? a.fields[0].value : null));
    const expected = [26, 26, 25.5, 25.5];
    expect(pressures).toHaveLength(4);
    for (const [i, p] of pressures.entries()) {
      expect(p).not.toBeNull();
      expect(p!).toBeCloseTo(expected[i]!, 3);
    }
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

  it("formatCarSetup renders readable tree", () => {
    const setup = parseCarSetup(readFileSync(FIXTURE))!;
    const text = formatCarSetup(setup);
    expect(text).toContain("#2 {");
    expect(text).toContain("220000");
    expect(text).toContain("ks_audi_r8_lms_gt3_evo_2_preset");
  });
});
