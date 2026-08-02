import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { carSlugFromPresetId } from "../server/games/ac-evo/carsetup";
import { parseCarSetup } from "../server/games/ac-evo/carsetup-wire";
import { getAllAcEvoCars } from "../shared/ac-evo-car-data";

/**
 * `POST /api/tunes/place-setup` accepts a binary AC EVO `.carsetup` as base64
 * alongside the original JSON path.
 *
 * The one thing that actually matters here is BYTE FIDELITY. `.carsetup` is
 * protobuf wire format with no shipped schema, and `carsetup-writer.ts` patches
 * a setup by splicing bytes at offsets recorded during decode. Re-serialising a
 * file — even "losslessly" — would move those offsets and silently corrupt
 * every later write. So the placed file must be byte-identical to the dropped
 * one, which is why the route writes the Buffer verbatim instead of going
 * through JSON.stringify.
 *
 * These assertions cover the encode/decode contract the route depends on rather
 * than booting an HTTP server: the route's own logic is a base64 decode, a
 * `parseCarSetup` validity gate, and a verbatim write.
 */

const FIXTURE = resolve(import.meta.dir, "artifacts/carsetup/Default-12312.carsetup");

describe("place-setup: binary .carsetup round-trip", () => {
  test("base64 encode → decode is byte-identical", () => {
    const original = readFileSync(FIXTURE);

    // Exactly what the client does: bytes → base64 over the wire.
    const base64 = original.toString("base64");
    // Exactly what the route does: base64 → Buffer, written verbatim.
    const decoded = Buffer.from(base64, "base64");

    expect(decoded.length).toBe(original.length);
    expect(decoded.equals(original)).toBe(true);
  });

  test("a round-tripped file still decodes as a setup", () => {
    const original = readFileSync(FIXTURE);
    const decoded = Buffer.from(original.toString("base64"), "base64");

    const before = parseCarSetup(original);
    const after = parseCarSetup(decoded);

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // Byte offsets are what carsetup-writer.ts patches against, so the whole
    // decoded tree — spans included — must be identical, not merely equivalent.
    expect(after).toEqual(before!);
  });

  test("JSON.stringify round-trip does NOT survive — why the binary path exists", () => {
    const original = readFileSync(FIXTURE);
    // The pre-existing JSON path would have written the file like this. It is
    // not a valid setup afterwards, which is the bug this change avoids.
    const viaJson = Buffer.from(JSON.stringify(original.toString("utf-8")), "utf-8");
    expect(viaJson.equals(original)).toBe(false);
  });

  test("the validity gate rejects a file that is not a setup", () => {
    // The route refuses to write junk into the driver's game folder.
    expect(parseCarSetup(Buffer.from("this is not a carsetup", "utf-8"))).toBeNull();

    // ⚠️ An empty buffer does NOT come back null — it decodes to an empty wire
    // tree. A `!parseCarSetup(bytes)` check alone would therefore accept it, so
    // the route additionally requires at least one decoded field. Pinned here
    // because the null-only guard looks correct and is not.
    const empty = parseCarSetup(Buffer.alloc(0));
    expect(empty).not.toBeNull();
    expect(empty!.raw.length).toBe(0);

    // A real setup is what passing the gate looks like.
    expect(parseCarSetup(readFileSync(FIXTURE))!.raw.length).toBeGreaterThan(0);
  });
});

/**
 * A dropped `.carsetup` names its own car via the preset id, so the driver
 * should never have to retype a car folder the file already knows.
 *
 * The slug must be validated against the canonical roster rather than trusted:
 * `_preset_` is an observed delimiter, not a documented one, so an unmatched
 * slug has to read as "unknown" instead of pre-filling a folder name that would
 * silently create a bogus directory under the driver's game install.
 */
describe("carSlugFromPresetId", () => {
  const FIXTURE_DIR = resolve(import.meta.dir, "artifacts/carsetup");

  /**
   * Not every `.carsetup` names its car — `Tourist.carsetup` is a real file
   * from a driver's Downloads that decodes perfectly (16 wire fields) yet has
   * no field #9 at all, so there is no preset id and nothing to read.
   *
   * So the claim is conditional: a fixture that HAS a preset id must resolve to
   * a real roster car, and one without must resolve to nothing rather than to a
   * guess. An earlier version of this test asserted the unconditional version
   * and only passed because every fixture then happened to carry a preset id.
   */
  test("a fixture with a preset id resolves to a roster car; one without resolves to null", () => {
    const models = new Set(getAllAcEvoCars().map((c) => c.model));
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".carsetup"));
    expect(files.length).toBeGreaterThan(0);

    let withPreset = 0;
    let withoutPreset = 0;
    for (const f of files) {
      const setup = parseCarSetup(readFileSync(resolve(FIXTURE_DIR, f)))!;
      const slug = carSlugFromPresetId(setup.presetId);
      if (setup.presetId == null) {
        withoutPreset++;
        expect(slug, `${f} has no preset id, so no car may be inferred`).toBeNull();
      } else {
        withPreset++;
        expect(slug, `${f} (${setup.presetId})`).not.toBeNull();
        expect(models.has(slug!), `${f} → ${slug} not in roster`).toBe(true);
      }
    }
    // Both cases are represented, so neither branch can rot unnoticed.
    expect(withPreset).toBeGreaterThan(0);
    expect(withoutPreset).toBeGreaterThan(0);
  });

  test("strips the ks_ prefix and cuts at the first _preset_", () => {
    expect(carSlugFromPresetId("ks_audi_r8_lms_gt3_evo_2_preset_r8gt3_mech_1_preset_r8gt3_visual_1")).toBe(
      "audi_r8_lms_gt3_evo_2",
    );
    expect(carSlugFromPresetId("ks_ferrari_sf_25_preset_sf25_mech_1_preset_sf25_visual_1")).toBe("ferrari_sf_25");
  });

  test("a slug with no preset suffix is returned whole", () => {
    expect(carSlugFromPresetId("ks_ferrari_sf_25")).toBe("ferrari_sf_25");
    // No vendor prefix either — take it as-is rather than guessing.
    expect(carSlugFromPresetId("some_other_car")).toBe("some_other_car");
  });

  test("missing or empty preset id yields null, never a bogus slug", () => {
    expect(carSlugFromPresetId(null)).toBeNull();
    expect(carSlugFromPresetId(undefined)).toBeNull();
    expect(carSlugFromPresetId("")).toBeNull();
    // Prefix only — nothing left after stripping, so there is no car to report.
    expect(carSlugFromPresetId("ks_")).toBeNull();
  });

  /**
   * A car missing from the roster must STILL yield its folder name.
   *
   * shared/ac-evo-car-data is a static CSV that has to be re-extracted after a
   * game update, so it lags the game by design. Gating the folder on a roster
   * hit — which is what this route did first — left the driver retyping a name
   * the file already states correctly, for exactly the newest cars.
   *
   * The roster hit only decides whether a friendly display name is available.
   */
  test("an unknown slug still gives a usable folder name", () => {
    const models = new Set(getAllAcEvoCars().map((c) => c.model));
    const slug = carSlugFromPresetId("ks_not_a_real_car_preset_x");
    expect(slug).toBe("not_a_real_car");
    // Not in the roster …
    expect(models.has(slug!)).toBe(false);
    // … but the slug is what the game names the folder, so it is still what the
    // route reports as carModel.
    expect(slug).toBeTruthy();
  });
});
