import { describe, expect, test } from "bun:test";
import {
  AccSetupJsonSchema,
  isSetupFileNameForGame,
  setupFileFormat,
  setupFileRejectReason,
} from "../shared/setup-file-formats";
import { tuneCrudRoutes } from "../server/routes/tune-crud-routes";

/**
 * Experiments accept exactly one setup format per game: ACC saves nested JSON,
 * AC EVO saves binary `.carsetup`. The two are not interchangeable — a JSON
 * "base setup" for AC EVO can never be patched by carsetup-writer.ts (which
 * splices protobuf bytes at recorded offsets), and a `.carsetup` handed to the
 * ACC readers is unparseable. So the wrong game's file is refused, not guessed
 * at, on both sides of the wire.
 */
describe("setup file format per game", () => {
  test("each game has exactly one extension", () => {
    expect(setupFileFormat("acc").extension).toBe(".json");
    expect(setupFileFormat("ac-evo").extension).toBe(".carsetup");
  });

  test("a file matches only its own game", () => {
    expect(isSetupFileNameForGame("acc", "MySetup.json")).toBe(true);
    expect(isSetupFileNameForGame("acc", "MySetup.carsetup")).toBe(false);
    expect(isSetupFileNameForGame("ac-evo", "Default-12312.carsetup")).toBe(true);
    expect(isSetupFileNameForGame("ac-evo", "Default-12312.json")).toBe(false);
  });

  test("extension matching is case-insensitive — Windows writes .JSON too", () => {
    expect(isSetupFileNameForGame("acc", "SETUP.JSON")).toBe(true);
    expect(isSetupFileNameForGame("ac-evo", "SETUP.CarSetup")).toBe(true);
  });

  test("the reject message names the mismatch, not just 'wrong file'", () => {
    expect(setupFileRejectReason("acc", "ok.json")).toBeNull();
    const wrongGame = setupFileRejectReason("acc", "ok.carsetup")!;
    expect(wrongGame).toContain(".carsetup");
    expect(wrongGame).toContain(".json");
    // A format neither game uses still gets a usable instruction.
    expect(setupFileRejectReason("ac-evo", "notes.txt")).toContain(".carsetup");
  });
});

/**
 * The JSON shape gate is deliberately loose — it pins only the keys every Kunos
 * setup carries. Validating the click-value tree field by field would reject
 * valid setups after any game update; the point is only to keep a file that
 * isn't a setup at all out of the driver's Setups folder.
 */
describe("AccSetupJsonSchema", () => {
  test("accepts a real setup and keeps its unknown fields", () => {
    const setup = {
      carName: "mclaren_720s_gt3_evo",
      basicSetup: { tyres: { tyreCompound: 0, tyrePressure: [49, 50, 49, 49] } },
      advancedSetup: { aeroBalance: { rideHeight: [56, 56, 79, 79] } },
      trackBopType: 0,
    };
    const parsed = AccSetupJsonSchema.parse(setup);
    expect(parsed.carName).toBe("mclaren_720s_gt3_evo");
    // Loose: fields we don't model must survive the round-trip, because the
    // parsed value is what gets written back out.
    expect((parsed as any).trackBopType).toBe(0);
    expect((parsed as any).basicSetup.tyres.tyrePressure).toEqual([49, 50, 49, 49]);
  });

  test("rejects JSON that isn't a setup", () => {
    // A lap export, a tune catalog entry, a random config — all valid JSON.
    expect(AccSetupJsonSchema.safeParse({ laps: [], version: 2 }).success).toBe(false);
    expect(AccSetupJsonSchema.safeParse({ carName: "x" }).success).toBe(false);
    expect(AccSetupJsonSchema.safeParse({ basicSetup: {} }).success).toBe(false);
    expect(AccSetupJsonSchema.safeParse({ carName: "", basicSetup: {} }).success).toBe(false);
    expect(AccSetupJsonSchema.safeParse([]).success).toBe(false);
    expect(AccSetupJsonSchema.safeParse(null).success).toBe(false);
  });
});

describe("POST /api/tunes/place-setup — one format per game", () => {
  async function place(body: unknown) {
    return await tuneCrudRoutes.request("/api/tunes/place-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const accSetup = {
    carName: "mclaren_720s_gt3_evo",
    basicSetup: { tyres: { tyreCompound: 0 } },
  };

  test("ACC refuses a .carsetup name", async () => {
    const res = await place({ gameId: "acc", carName: "mclaren_720s_gt3_evo", trackName: "spa", fileName: "base.carsetup", content: accSetup });
    expect(res.status).toBe(400);
  });

  test("ACC refuses a base64 binary payload", async () => {
    const res = await place({
      gameId: "acc",
      carName: "mclaren_720s_gt3_evo",
      trackName: "spa",
      fileName: "base.json",
      contentBase64: Buffer.from("whatever").toString("base64"),
    });
    expect(res.status).toBe(400);
  });

  test("AC EVO refuses a .json name", async () => {
    const res = await place({ gameId: "ac-evo", carName: "ford_mustang_gt3", trackName: "spa", fileName: "base.json", content: accSetup });
    expect(res.status).toBe(400);
  });

  test("AC EVO refuses a JSON payload even with the right extension", async () => {
    // This is the legacy AC-EVO-as-JSON path, now closed on purpose: such a
    // base setup can never be patched by carsetup-writer.ts.
    const res = await place({ gameId: "ac-evo", carName: "ford_mustang_gt3", trackName: "spa", fileName: "base.carsetup", content: accSetup });
    expect(res.status).toBe(400);
  });

  test("ACC refuses JSON that isn't a setup", async () => {
    const res = await place({ gameId: "acc", carName: "mclaren_720s_gt3_evo", trackName: "spa", fileName: "base.json", content: { laps: [] } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBeTruthy();
  });

  test("an unknown gameId is refused outright", async () => {
    const res = await place({ gameId: "fm-2023", carName: "x", trackName: "spa", fileName: "base.json", content: accSetup });
    expect(res.status).toBe(400);
  });
});
