import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../src/parser";
import { captureAcEvoParserCheckpoint, restoreAcEvoParserCheckpoint } from "../src/parser";
import { acEvoParser } from "../src/game-parser";
import { ACEVO_PACKED_MAGIC, packTriplet } from "@raceiq/capture-formats/kunos/pack-triplet";
test("AC Evo parser checkpoint encodes and restores cache state", () => {
  const cache = createAcEvoParserCache();
  cache.playerSlotState.slot = 4;
  cache.playerSlotState.scores[4] = 12.5;
  cache.playerSlotState.scoredFrames = 10;
  cache.distanceState.outputM = 123.25;
  const restored = restoreAcEvoParserCheckpoint(captureAcEvoParserCheckpoint(cache));
  expect(restored.playerSlotState.slot).toBe(4);
  expect(restored.playerSlotState.scores[4]).toBe(12.5);
  expect(restored.playerSlotState.scoredFrames).toBe(10);
  expect(restored.distanceState.outputM).toBe(123.25);
  expect(() => restoreAcEvoParserCheckpoint(Buffer.from('{"format":"raceiq:ac-evo-parser","version":2}')))
    .toThrow("Invalid or unsupported AC Evo parser checkpoint");
});

test("AC Evo checkpoint rejects malformed nested state", () => {
  const checkpoint = JSON.parse(new TextDecoder().decode(captureAcEvoParserCheckpoint(createAcEvoParserCache())));
  checkpoint.cache.playerSlotState.previousCoordinates = {};
  expect(() => restoreAcEvoParserCheckpoint(Buffer.from(JSON.stringify(checkpoint))))
    .toThrow("Invalid or unsupported AC Evo parser checkpoint");
});

import { parseAcEvoLapIndex } from "../src/lap-index";
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

function writeNativeControl(
  physics: Buffer,
  graphics: Buffer,
  values: { physicsId: number; graphicsId: number; playerId?: bigint; focusedId?: bigint; ai?: number; status?: number },
) {
  physics.writeInt32LE(values.physicsId, PHYSICS.packetId.offset);
  physics.writeInt32LE(values.ai ?? 0, PHYSICS.isAIControlled.offset);
  graphics.writeInt32LE(values.graphicsId, GRAPHICS_EVO.packetId.offset);
  graphics.writeInt32LE(values.status ?? ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
  const playerId = values.playerId ?? 0x10000000200000003n;
  const focusedId = values.focusedId ?? playerId;
  graphics.writeBigUInt64LE(focusedId & 0xffffffffffffffffn, GRAPHICS_EVO.focused_car_id_a.offset);
  graphics.writeBigUInt64LE(focusedId >> 64n, GRAPHICS_EVO.focused_car_id_b.offset);
  graphics.writeBigUInt64LE(playerId & 0xffffffffffffffffn, GRAPHICS_EVO.player_car_id_a.offset);
  graphics.writeBigUInt64LE(playerId >> 64n, GRAPHICS_EVO.player_car_id_b.offset);
}

function observeNativeControl(
  cache: ReturnType<typeof createAcEvoParserCache>,
  buffers: ReturnType<typeof emptyBuffers>,
  values: Parameters<typeof writeNativeControl>[2],
  timestampMs = 1000 + values.physicsId,
) {
  writeNativeControl(buffers.physics, buffers.graphics, values);
  writeCString(buffers.staticData, STATIC_EVO.sm_version.offset, STATIC_EVO.sm_version.size, "1.0");
  writeCString(buffers.staticData, STATIC_EVO.ac_evo_version.offset, STATIC_EVO.ac_evo_version.size, "0.6.2");
  return parseAcEvoBuffers(buffers.physics, buffers.graphics, buffers.staticData, cache, timestampMs);
}

describe("AC Evo parser native identity behavior", () => {
  test("empty native source names stay unavailable", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();
    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(cache.carId).toBe("");
    expect(cache.trackId).toBe("");
    expect(packet.carId).toBe("");
    expect(packet.trackId).toBe("");
  });

  test("unmapped source names remain exact native identities", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "__Unknown Native Car__");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "__Unknown Native Venue__");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "Custom Layout");
    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache())!;
    expect(packet.carId).toBe("__Unknown Native Car__");
    expect(packet.trackId).toBe(JSON.stringify(["__Unknown Native Venue__", "Custom Layout"]));
  });

  test("full and compact parsers preserve native source identities and distinguish configurations", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "Porsche 992 GT3 R");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "Monza");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "GP");
    const full = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache())!;
    const compact = parseAcEvoLapIndex(physics, graphics, staticData, createAcEvoParserCache())!;
    expect(full.carId).toBe("Porsche 992 GT3 R");
    expect(full.trackId).toBe(JSON.stringify(["Monza", "GP"]));
    expect(compact.carId).toBe(full.carId);
    expect(compact.trackId).toBe(full.trackId);
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "Tourist");
    const alternate = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache())!;
    expect(alternate.trackId).not.toBe(full.trackId);
  });
  test("full and compact parsers preserve native flag evidence", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    graphics.writeInt32LE(5, GRAPHICS_EVO.flag.offset);
    const full = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache());
    const compact = parseAcEvoLapIndex(physics, graphics, staticData, createAcEvoParserCache());
    expect(full?.acc?.flagStatus).toBe("yellow");
    expect(compact?.acc?.flagStatus).toBe(full?.acc?.flagStatus);
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

  test("late track identity is native and blank STATIC clears it", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();
    parseAcEvoBuffers(physics, graphics, staticData, cache);
    expect(cache.trackId).toBe("");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "monza");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "GP");
    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(packet.trackId).toBe(JSON.stringify(["monza", "GP"]));
    staticData.fill(0);
    const blank = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(blank.trackId).toBe("");
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
describe("AC Evo active-controller evidence", () => {
  test("fresh equal full GUIDs and non-AI control identify local-player role, independent of display names", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    writeCString(buffers.graphics, GRAPHICS_EVO.driver_name.offset, GRAPHICS_EVO.driver_name.size, "Zoë 🚗");
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    const packet = observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 })!;
    expect(packet.driverActor?.actorId).toBe("ac-evo-control:local-player");
    expect(packet.driverActor?.bindingScope).toBe("installation");
    expect(packet.driverActor?.sessionId).toBe("ac-evo-player-car:00000003000000020000000100000000");
    expect(packet.driverActor?.observedAtMs).toBe(1002);
    expect(packet.acc?.acEvo?.focusedCarIdWords).toEqual(packet.acc?.acEvo?.playerCarIdWords);
  });

  test("AI control or different focused car positively projects Other", () => {
    for (const values of [
      { physicsId: 2, graphicsId: 2, ai: 1 },
      { physicsId: 2, graphicsId: 2, focusedId: 0x80000000000000010000000200000003n },
    ]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      expect(observeNativeControl(cache, buffers, values)?.driverActor?.actorId)
        .toBe("ac-evo-control:other");
    }
  });

  test("missing or zero native IDs and unsupported control flags remain Unknown", () => {
    for (const values of [
      { physicsId: 2, graphicsId: 2, playerId: 0n },
      { physicsId: 2, graphicsId: 2, focusedId: 0n },
      { physicsId: 2, graphicsId: 2, ai: 2 },
    ]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      expect(observeNativeControl(cache, buffers, values)?.driverActor).toBeNull();
    }
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    const missingTime = parseAcEvoBuffers(buffers.physics, buffers.graphics, buffers.staticData, cache);
    expect(missingTime?.driverActor).toBeNull();
  });
  test("unsupported layouts do not decode control fields using v0.6 offsets", () => {
    for (const version of ["", "0.5", "0.60", "0.6garbage", "1.0"]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      writeNativeControl(buffers.physics, buffers.graphics, { physicsId: 3, graphicsId: 3 });
      writeCString(buffers.staticData, STATIC_EVO.ac_evo_version.offset, STATIC_EVO.ac_evo_version.size, version);
      const packet = parseAcEvoBuffers(buffers.physics, buffers.graphics, buffers.staticData, cache, 1003)!;
      expect(packet.driverActor).toBeNull();
      expect(packet.acc?.acEvo?.isAIControlled).toBeNull();
      expect(packet.acc?.acEvo?.playerCarIdWords).toBeNull();
      expect(packet.acc?.acEvo?.focusedCarIdWords).toBeNull();
    }
  });

  test("missing or changed shared-memory ABI versions invalidate known local control", () => {
    for (const sharedMemoryVersion of ["", "1.1", "2.0"]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      writeNativeControl(buffers.physics, buffers.graphics, { physicsId: 3, graphicsId: 3 });
      writeCString(buffers.staticData, STATIC_EVO.sm_version.offset, STATIC_EVO.sm_version.size, sharedMemoryVersion);
      const unknown = parseAcEvoBuffers(buffers.physics, buffers.graphics, buffers.staticData, cache, 1003)!;
      expect(unknown.driverActor).toBeNull();
      expect(unknown.acc?.acEvo?.sharedMemoryVersion).toBe(sharedMemoryVersion);
      expect(unknown.acc?.acEvo?.playerCarIdWords).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 })?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 5, graphicsId: 5 })?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
    }
  });

  test("different page sizes cannot certify v0.6 native actor offsets", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
    writeNativeControl(buffers.physics, buffers.graphics, { physicsId: 3, graphicsId: 3 });
    const unknown = parseAcEvoBuffers(
      buffers.physics, Buffer.concat([buffers.graphics, Buffer.alloc(4)]), buffers.staticData, cache, 1003,
    )!;
    expect(unknown.driverActor).toBeNull();
    expect(unknown.acc?.acEvo?.focusedCarIdWords).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 })?.driverActor).toBeNull();
  });

  test("independent physics and graphics cadences retain original evidence time without Unknown gaps", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    expect(observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 })?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 1 })?.driverActor).toBeNull();
    const synchronized = observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 2 })!;
    expect(synchronized.driverActor?.actorId).toBe("ac-evo-control:local-player");
    expect(synchronized.driverActor?.observedAtMs).toBe(1003);
    const physicsOnly = observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 2 })!;
    expect(physicsOnly.driverActor?.observedAtMs).toBe(1003);
    const graphicsOnly = observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 3 }, 1005)!;
    expect(graphicsOnly.driverActor?.actorId).toBe("ac-evo-control:local-player");
    expect(graphicsOnly.driverActor?.observedAtMs).toBe(1004);
  });

  test("duplicate native pages age out despite later wrapper timestamps", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    const original = observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 })!;
    for (const timestampMs of [1002, 1100, 1300, 1502]) {
      const cached = observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 }, timestampMs)!;
      expect(cached.driverActor?.actorId).toBe("ac-evo-control:local-player");
      expect(cached.driverActor?.observedAtMs).toBe(original.driverActor!.observedAtMs);
      expect(cached.acc?.acEvo?.sourceCaptureUtcMs).toBe(timestampMs);
    }
    expect(observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 }, 1503)?.driverActor).toBeNull();
  });

  test("a stalled native page cannot borrow freshness from the advancing page", () => {
    for (const stalledPage of ["physics", "graphics"]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      const advancing = { physicsId: stalledPage === "physics" ? 2 : 3, graphicsId: stalledPage === "graphics" ? 2 : 3 };
      expect(observeNativeControl(cache, buffers, advancing, 1300)?.driverActor?.observedAtMs).toBe(1002);
      const expired = { physicsId: stalledPage === "physics" ? 2 : 4, graphicsId: stalledPage === "graphics" ? 2 : 4 };
      expect(observeNativeControl(cache, buffers, expired, 1503)?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 5, graphicsId: 5 }, 1504)?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
    }
  });

  test("AI takeover and foreign focus stop cached local control at either page cadence", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    const local = observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 })!;
    const ai = observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 2, ai: 1 })!;
    expect(ai.driverActor?.actorId).toBe("ac-evo-control:other");
    const localAgain = observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 2 })!;
    expect(localAgain.driverActor?.actorId).toBe("ac-evo-control:local-player");
    const foreign = observeNativeControl(cache, buffers, {
      physicsId: 4, graphicsId: 3, focusedId: 0xffffffffffffffff1000000200000003n,
    }, 1005)!;
    expect(foreign.driverActor?.actorId).toBe("ac-evo-control:other");
    expect(foreign.acc?.acEvo?.focusedCarIdWords).toEqual([3, 0x10000002, 0xffffffff, 0xffffffff]);
    expect(local.acc?.acEvo?.focusedCarIdWords).toEqual([3, 2, 1, 0]);
  });

  test("invalid native state clears prior local evidence and requires renewed pages", () => {
    for (const invalid of [{ ai: 2 }, { focusedId: 0n }, { playerId: 0n }]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3, ...invalid })?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, 1004)?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 }, 1005)?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
    }
  });

  test("facts changing without their publisher counter are conflicting, not cached Self", () => {
    for (const conflict of [{ ai: 1 }, { focusedId: 99n }]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      expect(observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2, ...conflict }, 1003)?.driverActor)
        .toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 2, ...conflict }, 1004)?.driverActor)
        .toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 3, ...conflict }, 1005)?.driverActor?.actorId)
        .toBe("ac-evo-control:other");
    }
  });

  test("backwards timestamps and real capture gaps cannot reuse old freshness", () => {
    for (const discontinuity of [1001, 1600]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, discontinuity)?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 3 }, discontinuity + 1)?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 5, graphicsId: 4 }, discontinuity + 2)?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
    }
  });

  test("native counter resets require fresh pages but signed int32 rollover remains continuous", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 9, graphicsId: 9 }, 1000);
    observeNativeControl(cache, buffers, { physicsId: 10, graphicsId: 10 }, 1001);
    expect(observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 }, 1002)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 1 }, 1003)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 2 }, 1004)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
    const rollover = createAcEvoParserCache();
    observeNativeControl(rollover, buffers, { physicsId: 0x7ffffffe, graphicsId: 0x7ffffffe }, 1000);
    observeNativeControl(rollover, buffers, { physicsId: 0x7fffffff, graphicsId: 0x7fffffff }, 1001);
    expect(observeNativeControl(rollover, buffers, { physicsId: -0x80000000, graphicsId: -0x80000000 }, 1002)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
  });

  test("pause, replay, menu, and restored source state invalidate prior native evidence", () => {
    for (const status of [ACEVO_STATUS.AC_PAUSE, ACEVO_STATUS.AC_REPLAY, ACEVO_STATUS.AC_OFF]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      const inactive = observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3, status });
      if (status === ACEVO_STATUS.AC_PAUSE) {
        expect(inactive?.driverActor).toBeNull();
        expect(inactive?.acc?.acEvo?.status).toBe(status);
      } else {
        expect(inactive).toBeNull();
      }
      expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, 1004)?.driverActor).toBeNull();
      expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 }, 1005)?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
      const restored = restoreAcEvoParserCheckpoint(captureAcEvoParserCheckpoint(cache));
      expect(observeNativeControl(restored, buffers, { physicsId: 5, graphicsId: 5 }, 1006)?.driverActor).toBeNull();
      expect(observeNativeControl(restored, buffers, { physicsId: 6, graphicsId: 6 }, 1007)?.driverActor?.actorId)
        .toBe("ac-evo-control:local-player");
    }
  });

  test("new player vehicle GUID starts a source scope, not a person identity", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    const previous = observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 })!;
    const playerId = 0xffffffffffffffffffffffffffffffffn;
    expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3, playerId })?.driverActor).toBeNull();
    const next = observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4, playerId })!;
    expect(next.driverActor?.actorId).toBe("ac-evo-control:local-player");
    expect(next.driverActor?.sessionId).toBe("ac-evo-player-car:ffffffffffffffffffffffffffffffff");
    expect(next.driverActor?.sessionId).not.toBe(previous.driverActor!.sessionId);
    expect(next.acc?.acEvo?.playerCarIdWords).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
  });

  test("missing or invalid recorded capture clocks cannot borrow host time", () => {
    for (const timestampMs of [0, -1, NaN, Infinity]) {
      const buffers = emptyBuffers();
      const cache = createAcEvoParserCache();
      observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
      observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
      const invalid = observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, timestampMs)!;
      expect(invalid.driverActor).toBeNull();
      expect(invalid.acc?.acEvo?.sourceCaptureUtcMs).toBeNull();
    }
  });

  test("advancing native counters at an unchanged capture clock are unverifiable", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
    expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, 1002)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 3 }, 1003)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 5, graphicsId: 4 }, 1004)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
  });

  test("truncated source packets and native track changes discard cached attribution", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
    expect(parseAcEvoBuffers(buffers.physics.subarray(0, PHYSICS.SIZE - 1), buffers.graphics, buffers.staticData, cache, 1003))
      .toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, 1004)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 }, 1005)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
    writeCString(buffers.staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "different-track");
    expect(observeNativeControl(cache, buffers, { physicsId: 5, graphicsId: 5 }, 1006)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 6, graphicsId: 6 }, 1007)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
  });

  test("replay priming cannot carry active-driver evidence across skipped source observations", () => {
    const buffers = emptyBuffers();
    const cache = createAcEvoParserCache();
    observeNativeControl(cache, buffers, { physicsId: 1, graphicsId: 1 });
    observeNativeControl(cache, buffers, { physicsId: 2, graphicsId: 2 });
    const frame = packTriplet(ACEVO_PACKED_MAGIC, 0, 0, buffers.physics, buffers.graphics, buffers.staticData);
    acEvoParser.primeParserState!(frame, cache);
    expect(observeNativeControl(cache, buffers, { physicsId: 3, graphicsId: 3 }, 1003)?.driverActor).toBeNull();
    expect(observeNativeControl(cache, buffers, { physicsId: 4, graphicsId: 4 }, 1004)?.driverActor?.actorId)
      .toBe("ac-evo-control:local-player");
  });
});
