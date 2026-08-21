import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../../server/games/ac-evo/parser";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS } from "../../../server/games/ac-evo/structs";

function emptyBuffers() {
  const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
  // Default status (0) is AC_OFF — parser gates out. Force AC_LIVE so the
  // parser runs through the full body and exercises the STATIC fallback paths.
  graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
  return {
    physics: Buffer.alloc(PHYSICS.SIZE),
    graphics,
    staticData: Buffer.alloc(STATIC_EVO.SIZE),
  };
}

function writeCString(buf: Buffer, offset: number, size: number, value: string) {
  buf.fill(0, offset, offset + size);
  buf.write(value, offset, Math.min(value.length, size - 1), "utf8");
}

describe("AC Evo parser — malformed/empty STATIC recovery", () => {
  test("zero-filled STATIC does not throw, track stays unidentified (-1), NOT Monza (0)", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    expect(packet!.gameId).toBe("ac-evo");
    // Ordinal 0 is Ferrari SF90 (car) / Monza GP (track) — an empty name must
    // stay unidentified (-1), never silently resolve to the first ordinal.
    expect(cache.carOrdinal).toBe(-1);
    expect(cache.trackOrdinal).toBe(-1);
    expect(packet!.TrackOrdinal).toBe(-1);
  });

  test("native packets keep wall-clock timestamps", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    physics.writeInt32LE(0, PHYSICS.packetId.offset);
    const before = Date.now();
    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache());
    const after = Date.now();

    expect(packet?.TimestampMS).toBeGreaterThanOrEqual(before);
    expect(packet?.TimestampMS).toBeLessThanOrEqual(after);
  });

  test("uses an explicit replay timestamp without changing native clock behavior", () => {
    const { physics, graphics, staticData } = emptyBuffers();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache(), 1_234_567);

    expect(packet?.TimestampMS).toBe(1_234_567);
  });

  test("unknown track name resolves to -1 sentinel, not ordinal 0", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "__not_a_real_track__");
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    expect(cache.trackOrdinal).toBe(-1);
  });

  test("track name populated mid-session resolves on the frame it appears", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();

    // Frame 1: game hasn't populated STATIC yet (production repro)
    parseAcEvoBuffers(physics, graphics, staticData, cache);
    expect(cache.trackOrdinal).toBe(-1);

    // Frame 2: game fills in the track name
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "monza");
    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);
    expect(packet).not.toBeNull();
    expect(cache.trackOrdinal).toBe(0); // Monza GP — now legitimately resolved
    expect(packet!.TrackOrdinal).toBe(0);
  });

  test("unknown car display name resolves to -1 sentinel, not ordinal 0", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "__Not A Real Car__");
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    // Ordinal 0 is Ferrari SF90 — an unknown car must not silently become it.
    expect(cache.carOrdinal).toBe(-1);
  });

  test("undersized buffers return null (no throw)", () => {
    const cache = createAcEvoParserCache();
    const packet = parseAcEvoBuffers(Buffer.alloc(PHYSICS.SIZE - 1), Buffer.alloc(GRAPHICS_EVO.SIZE), Buffer.alloc(STATIC_EVO.SIZE), cache);
    expect(packet).toBeNull();
  });

  test("maps source-provided fuel capacity in litres", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    physics.writeFloatLE(42, PHYSICS.fuel.offset);
    graphics.writeFloatLE(100, GRAPHICS_EVO.max_fuel.offset);

    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache());

    expect(packet).not.toBeNull();
    expect(packet!.Fuel).toBeCloseTo(42);
    expect(packet!.FuelCapacity).toBeCloseTo(100);
  });
});
