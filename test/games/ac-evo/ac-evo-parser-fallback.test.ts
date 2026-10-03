import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache } from "@raceiq/game-ac-evo/parser";
import { parseAcEvoLapIndex } from "@raceiq/game-ac-evo/lap-index";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO, TYRE_STATE, ACEVO_STATUS } from "@raceiq/capture-formats/ac-evo/structs";

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

  test("unknown track name resolves to -1 sentinel, not ordinal 0", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "__not_a_real_track__");
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    expect(cache.trackOrdinal).toBe(-1);
  });

  test("only explicit graphics flags confirm TC or ABS intervention", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    physics.writeFloatLE(0.5, PHYSICS.slipVibrations.offset);
    physics.writeFloatLE(0.5, PHYSICS.absVibrations.offset);
    physics.writeFloatLE(1, PHYSICS.tc.offset);
    physics.writeFloatLE(1, PHYSICS.abs.offset);
    const cache = createAcEvoParserCache();
    const vibration = parseAcEvoBuffers(physics, graphics, staticData, cache);
    expect(vibration!.acc!.tcIntervention).toBe(0);
    expect(vibration!.acc!.absIntervention).toBe(0);

    graphics.writeUInt8(1, GRAPHICS_EVO.tc_active.offset);
    graphics.writeUInt8(1, GRAPHICS_EVO.abs_active.offset);
    const intervention = parseAcEvoBuffers(physics, graphics, staticData, cache);
    expect(intervention!.acc!.tcIntervention).toBe(1);
    expect(intervention!.acc!.absIntervention).toBe(1);
  });

  test("full and compact parsers preserve on-track validity and ignore pit invalidity", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    for (const [raw, inPit, expected] of [
      [1, 0, true],
      [0, 0, false],
      [0, 1, null],
    ] as const) {
      graphics.writeUInt8(raw, GRAPHICS_EVO.is_valid_lap.offset);
      graphics.writeUInt8(inPit, GRAPHICS_EVO.is_in_pit_lane.offset);
      const full = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache());
      const compact = parseAcEvoLapIndex(physics, graphics, staticData, createAcEvoParserCache());
      expect(full?.acc?.isValidLap).toBe(expected);
      expect(compact?.acc?.isValidLap).toBe(expected);
    }
    graphics.writeUInt8(0, GRAPHICS_EVO.is_in_pit_lane.offset);
    graphics.writeUInt8(1, GRAPHICS_EVO.is_in_pit_box.offset);
    expect(parseAcEvoLapIndex(physics, graphics, staticData, createAcEvoParserCache())?.acc?.isValidLap).toBeNull();
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
    const packet = parseAcEvoBuffers(
      Buffer.alloc(PHYSICS.SIZE - 1),
      Buffer.alloc(GRAPHICS_EVO.SIZE),
      Buffer.alloc(STATIC_EVO.SIZE),
      cache,
    );
    expect(packet).toBeNull();
  });

  test("maps source-provided fuel capacity in litres", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    physics.writeFloatLE(42, PHYSICS.fuel.offset);
    graphics.writeFloatLE(100, GRAPHICS_EVO.max_fuel.offset);

    const packet = parseAcEvoBuffers(
      physics,
      graphics,
      staticData,
      createAcEvoParserCache(),
    );

    expect(packet).not.toBeNull();
    expect(packet!.Fuel).toBeCloseTo(42);
    expect(packet!.FuelCapacity).toBeCloseTo(100);
  });

  test("reads graphics contact-patch bands with wheel-relative inner and outer, not mirrored physics core", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const wheels = [
      { wheel: "FL", base: GRAPHICS_EVO.tyre_lf_base.offset, left: 71, middle: 72, right: 73 },
      { wheel: "FR", base: GRAPHICS_EVO.tyre_rf_base.offset, left: 81, middle: 82, right: 83 },
      { wheel: "RL", base: GRAPHICS_EVO.tyre_lr_base.offset, left: 91, middle: 92, right: 93 },
      { wheel: "RR", base: GRAPHICS_EVO.tyre_rr_base.offset, left: 101, middle: 102, right: 103 },
    ] as const;
    for (const { wheel, base, left, middle, right } of wheels) {
      physics.writeFloatLE(60, PHYSICS[`tyreCore${wheel}`].offset);
      physics.writeFloatLE(60, PHYSICS[`tyreTemp${wheel}`].offset);
      graphics.writeFloatLE(left, base + TYRE_STATE.temperatureLeft);
      graphics.writeFloatLE(middle, base + TYRE_STATE.temperatureCenter);
      graphics.writeFloatLE(right, base + TYRE_STATE.temperatureRight);
    }

    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache())!;
    for (const { wheel, left, middle, right } of wheels) {
      expect(packet[`TireTemp${wheel}`]).toBe(middle);
      expect(packet[`TireCarcassTemp${wheel}`]).toBe(60);
      expect(packet[`TireSurfaceTempInner${wheel}`]).toBe(wheel.endsWith("L") ? right : left);
      expect(packet[`TireSurfaceTempMiddle${wheel}`]).toBe(middle);
      expect(packet[`TireSurfaceTempOuter${wheel}`]).toBe(wheel.endsWith("L") ? left : right);
    }
  });
});
