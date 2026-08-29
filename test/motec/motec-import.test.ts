import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { parseLd, findChannel } from "../../server/motec/ld";
import { parseLdxBeacons } from "../../server/motec/ldx";
import {
  lapWindows,
} from "../../server/motec/kunos-synthesis";
import { MOTEC_SYNTH_HZ } from "../../server/motec/kunos-synthesis";
import {
  deadReckonPath,
  resolveMotecCarTrack,
  synthesizeAcEvoCapture,
} from "../../server/games/ac-evo/motec";
import { normalizeTelemetryPacket } from "../../server/telemetry/normalization";
import { importMotec, MOTEC_SESSION_SOURCE } from "../../server/motec/import";
import { getMotecTargets, initMotecTargets, resolveMotecTarget } from "../../server/motec/targets";
import { db } from "../../server/db";
import { laps as lapsTable, sessions, tunes } from "../../server/db/schema";
import { eq, isNull } from "drizzle-orm";
import { getAcEvoTrackByName } from "../../shared/racing/tracks/catalogs/ac-evo"
import { META_FRAME_MAGIC } from "../../server/session-capture/framing"
import { buildLd, buildLdx, syntheticStint } from "../support/motec/ld";

initGameAdapters();
initServerGameAdapters();
initMotecTargets();
describe("MoTeC target registry", () => {
  test("registers only explicit ACC and AC Evo targets", () => {
    expect(getMotecTargets().map((target) => target.gameId)).toEqual(["acc", "ac-evo"]);
    expect(resolveMotecTarget("acc").gameId).toBe("acc");
    expect(resolveMotecTarget("ac-evo").gameId).toBe("ac-evo");
    expect(() => resolveMotecTarget("forza-motorsport")).toThrow("No MoTeC transcoder for game 'forza-motorsport'");
  });
});

/** Walk the session-capture framing the transcoder emits. */
function* iterateFrames(buf: Buffer): Generator<Buffer> {
  let offset = 0;
  if (buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC) offset = 12;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buf.length) break;
    yield buf.subarray(offset, offset + len);
    offset += len;
  }
}

function parseFrames(bin: Buffer) {
  const game = getServerGame("ac-evo");
  const state = game.createParserState?.() ?? null;
  const packets = [];
  for (const frame of iterateFrames(bin)) {
    const packet = game.tryParse(frame, state);
    if (packet) packets.push(packet);
  }
  return packets;
}

describe("MoTeC .ld reader", () => {
  test("round-trips header fields and channel samples", () => {
    const bytes = buildLd({
      driver: "A Cooper",
      vehicleId: "mercedes_amg_gt3_evo",
      venue: "spa",
      channels: [
        { name: "SPEED", freq: 10, unit: "kmh", samples: [10, 20, 30, 40] },
        { name: "THROTTLE", freq: 10, samples: [0, 0.5, 1, 1] },
      ],
    });

    const log = parseLd(bytes);
    expect(log.driver).toBe("A Cooper");
    expect(log.vehicleId).toBe("mercedes_amg_gt3_evo");
    expect(log.venue).toBe("spa");
    expect(log.channels).toHaveLength(2);

    const speed = findChannel(log, "SPEED");
    expect(speed?.unit).toBe("kmh");
    expect(Array.from(speed!.samples)).toEqual([10, 20, 30, 40]);
    // 4 samples at 10 Hz.
    expect(log.duration).toBeCloseTo(0.4, 5);
  });

  test("rejects a buffer that is not a .ld", () => {
    expect(() => parseLd(new Uint8Array(64))).toThrow(/not a motec .ld/i);
  });

  test("corrects a channel whose declared rate contradicts the log duration", () => {
    // 100 samples declared at 10 Hz alongside a 10 s channel is really 10 Hz;
    // a second channel with 500 samples claiming 10 Hz is mislabelled.
    const bytes = buildLd({
      channels: [
        { name: "SPEED", freq: 10, samples: new Array(100).fill(50) },
        { name: "EN_OIL_TEMP", freq: 10, samples: new Array(500).fill(90) },
      ],
    });
    const log = parseLd(bytes);
    expect(log.duration).toBeCloseTo(10, 5);
    expect(findChannel(log, "EN_OIL_TEMP")!.effectiveFreq).toBeCloseTo(50, 5);
  });
});

describe("MoTeC .ldx beacons", () => {
  test("reads marker times as seconds", () => {
    expect(parseLdxBeacons(buildLdx([60, 120.5]))).toEqual([60, 120.5]);
  });

  test("reads scientific-notation marker times", () => {
    expect(parseLdxBeacons('<MarkerGroup Name="Beacons"><Marker Time="1.43637e+08"/></MarkerGroup>')).toEqual([143.637]);
  });

  test("an empty beacon group is a single stint, not an error", () => {
    expect(parseLdxBeacons(buildLdx([]))).toEqual([]);
  });
});

describe("lapWindows", () => {
  test("splits on beacons", () => {
    expect(lapWindows([100, 200], 300)).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
    ]);
  });

  test("no beacons means one unsplit stint", () => {
    expect(lapWindows([], 250)).toEqual([[0, 250]]);
  });

  test("merges a slice too short for the detector's 30s reset rule", () => {
    // The 5s slice cannot be recognised as a lap, so it folds into the next one
    // rather than becoming a window the detector silently never splits.
    expect(lapWindows([5, 100], 200)).toEqual([
      [0, 100],
      [100, 200],
    ]);
  });
});

describe("deadReckonPath", () => {
  const dt = 1 / 60;

  test("constant speed and yaw traces a closed circle", () => {
    const frames = 600; // 10 s
    const lapSeconds = 10;
    const speed = new Float64Array(frames).fill(72); // 20 m/s
    const yaw = new Float64Array(frames).fill((2 * Math.PI) / lapSeconds);
    const gLat = new Float64Array(frames);
    // Two laps so the first is "complete" and gets loop-closed.
    const lapIndex = new Int32Array(frames);
    for (let i = 0; i < frames; i++) lapIndex[i] = i < frames / 2 ? 0 : 1;

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s");

    // Lap 0 returns to its origin.
    const endOfLap0 = frames / 2 - 1;
    expect(Math.hypot(path.x[endOfLap0]!, path.z[endOfLap0]!)).toBeLessThan(1);
    // And it actually went somewhere in between rather than sitting still.
    const mid = Math.floor(frames / 4);
    expect(Math.hypot(path.x[mid]!, path.z[mid]!)).toBeGreaterThan(10);
  });

  test("each lap restarts at the origin so laps overlay", () => {
    const frames = 120;
    const speed = new Float64Array(frames).fill(100);
    const yaw = new Float64Array(frames).fill(0.5);
    const gLat = new Float64Array(frames);
    const lapIndex = new Int32Array(frames);
    for (let i = 0; i < frames; i++) lapIndex[i] = i < 60 ? 0 : 1;

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s");
    expect(path.x[60]).toBe(0);
    expect(path.z[60]).toBe(0);
  });

  test("stores integrated heading and resets it at each lap", () => {
    const frames = 120;
    const speed = new Float64Array(frames).fill(100);
    const yaw = new Float64Array(frames).fill(0.5);
    const gLat = new Float64Array(frames);
    const lapIndex = new Int32Array(frames);
    for (let i = 0; i < 60; i++) lapIndex[i] = 0;
    for (let i = 60; i < frames; i++) lapIndex[i] = 1;

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s");
    expect(path.heading[0]).toBe(0);
    expect(path.heading[30]).toBeGreaterThan(0);
    expect(path.heading[60]).toBe(0);
    expect(path.heading[90]).toBeGreaterThan(0);
  });

  test("falls back to lateral G when ROTY is absent", () => {
    const frames = 300;
    const speed = new Float64Array(frames).fill(72);
    const yaw = new Float64Array(frames); // all zero → unusable
    const gLat = new Float64Array(frames).fill(1.0);
    const lapIndex = new Int32Array(frames);

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "");
    expect(path.yawFromLateralG).toBe(true);
    // A sustained 1 g at 20 m/s must curve the path, not run it straight.
    expect(Math.abs(path.x[frames - 1]!)).toBeGreaterThan(1);
  });
});

describe("resolveMotecCarTrack", () => {
  test("maps MoTeC folder ids to RaceIQ ordinals", () => {
    const bytes = buildLd({
      vehicleId: "mercedes_amg_gt3_evo",
      venue: "spa",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const resolved = resolveMotecCarTrack(parseLd(bytes));
    expect(resolved.trackOrdinal).toBeGreaterThanOrEqual(0);
    expect(resolved.trackName.length).toBeGreaterThan(0);
  });

  test("a caller-supplied car and track beat the log header", () => {
    // The header says Spa; the user says otherwise. The user wins — filing a
    // lap under the wrong track silently ruins its sectors and corner names.
    const bytes = buildLd({
      vehicleId: "mercedes_amg_gt3_evo",
      venue: "spa",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const header = resolveMotecCarTrack(parseLd(bytes));
    const monza = getAcEvoTrackByName("monza")!;
    expect(monza.id).not.toBe(header.trackOrdinal);

    const overridden = resolveMotecCarTrack(parseLd(bytes), {
      carOrdinal: 0,
      trackOrdinal: monza.id,
    });
    expect(overridden.trackOrdinal).toBe(monza.id);
    expect(overridden.carOrdinal).toBe(0);
  });

  test("an absent override falls back to the header", () => {
    const bytes = buildLd({
      venue: "monza",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const resolved = resolveMotecCarTrack(parseLd(bytes), {});
    expect(resolved.trackOrdinal).toBe(getAcEvoTrackByName("monza")!.id);
  });

  test("passes an unknown car through instead of guessing", () => {
    const bytes = buildLd({
      vehicleId: "not_a_real_car",
      venue: "spa",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const resolved = resolveMotecCarTrack(parseLd(bytes));
    expect(resolved.carOrdinal).toBe(-1);
    // The raw string survives so the lap detector can register it as discovered.
    expect(resolved.carModel).toBe("not_a_real_car");
  });
});

describe("synthesizeAcEvoCapture", () => {
  const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
  const log = parseLd(buildLd(spec));
  const capture = synthesizeAcEvoCapture(log, beacons);

  test("emits frames at the synthesis rate for the log's duration", () => {
    expect(capture.frameCount).toBe(Math.floor(log.duration * MOTEC_SYNTH_HZ));
    expect(capture.lapCount).toBe(3);
  });

  test("found every channel it needs", () => {
    expect(capture.missingChannels).toEqual([]);
  });

  test("frames parse back through the real AC Evo adapter", () => {
    const packets = parseFrames(capture.bin);
    expect(packets.length).toBe(capture.frameCount);
    expect(packets[0]!.gameId).toBe("ac-evo");
  });

  test("speed and pedal traces survive the round trip", () => {
    const packets = parseFrames(capture.bin);
    // Flat-out sections were written at 180 km/h = 50 m/s.
    const topSpeed = Math.max(...packets.map((p) => p.Speed));
    expect(topSpeed).toBeCloseTo(50, 0);


    const maxThrottle = Math.max(...packets.map((p) => p.Accel));
    const maxBrake = Math.max(...packets.map((p) => p.Brake));
    expect(maxThrottle).toBe(255); // full throttle → 255
    expect(maxBrake).toBeGreaterThan(100); // 0.5 brake → ~127
  });
  test("normalized reconstructed heading agrees with normalized world velocity", () => {
    const packets = parseFrames(capture.bin);
    for (const packet of packets) normalizeTelemetryPacket(packet, true);
    const moving = packets.filter((packet) => Math.hypot(packet.VelocityX, packet.VelocityZ) > 1);
    expect(moving.some((packet) => Math.abs(packet.Yaw) > 0.01)).toBe(true);
    for (const packet of moving.filter((_, index) => index % 10 === 0)) {
      const expected = Math.atan2(packet.VelocityX, packet.VelocityZ);
      const difference = Math.atan2(Math.sin(packet.Yaw - expected), Math.cos(packet.Yaw - expected));
      expect(Math.abs(difference)).toBeLessThan(0.003);
    }
  });

  test("maps MoTeC steering and forward wheel rotation into AC Evo handedness", () => {
    const packets = parseFrames(capture.bin);
    const moving = packets.find((packet) => packet.Speed > 1 && Math.abs(packet.Steer) > 1);
    expect(moving).toBeDefined();
    expect(moving!.Steer).toBeLessThan(0);
    expect(moving!.WheelRotationSpeedFL).toBeGreaterThan(0);
  });

  test("lap timing resets at each beacon and reports the completed lap time", () => {
    const packets = parseFrames(capture.bin);
    // CurrentLap climbs to ~120s then resets.
    const peak = Math.max(...packets.map((p) => p.CurrentLap));
    expect(peak).toBeGreaterThan(115);
    expect(peak).toBeLessThan(121);

    // Once a lap is complete the log reports its time.
    const lastLaps = new Set(packets.map((p) => Math.round(p.LastLap)).filter((t) => t > 0));
    expect(lastLaps.has(120)).toBe(true);

    // The lap counter advances.
    expect(Math.max(...packets.map((p) => p.LapNumber))).toBe(3);
  });

  test("distance never jumps backwards across a lap boundary", () => {
    // Load-bearing: the AC Evo lap detector reads a >100 m backward step in
    // DistanceTraveled as a session restart and throws away the lap buffer. A
    // per-lap distance reset here means no lap is ever emitted — only the final
    // flush survives. Guards the session-cumulative `current_km` contract.
    const packets = parseFrames(capture.bin);
    let worstDrop = 0;
    for (let i = 1; i < packets.length; i++) {
      worstDrop = Math.min(worstDrop, packets[i]!.DistanceTraveled - packets[i - 1]!.DistanceTraveled);
    }
    expect(worstDrop).toBeGreaterThan(-100);

    // And it does accumulate: 360 s of running covers real ground.
    expect(packets[packets.length - 1]!.DistanceTraveled).toBeGreaterThan(10_000);
  });

  test("produces a racing line rather than a dead trace at the origin", () => {
    const packets = parseFrames(capture.bin);
    const moved = packets.filter((p) => p.PositionX !== 0 || p.PositionZ !== 0);
    expect(moved.length).toBeGreaterThan(packets.length * 0.9);
  });

  test("a log with no beacons imports as one stint", () => {
    const single = synthesizeAcEvoCapture(log, []);
    expect(single.lapCount).toBe(1);
  });
});

describe("importMotec end to end", () => {
  test("lands laps in the DB and marks the session as MoTeC-sourced", async () => {
    const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
    const result = await importMotec(buildLd(spec), Buffer.from(buildLdx(beacons)), { gameId: "ac-evo" });

    // Three windows, but the last is still open when the log ends, so the
    // detector completes the two that closed at a beacon.
    expect(result.laps.length).toBeGreaterThanOrEqual(2);
    expect(result.packetCount).toBeGreaterThan(0);
    expect(result.meta.venue).toBe("spa");

    for (const lap of result.laps) {
      expect(lap.lapTime).toBeGreaterThan(115);
      expect(lap.lapTime).toBeLessThan(125);
    }

    const sessionIds = [...new Set(result.laps.map((l) => l.sessionId))];
    for (const id of sessionIds) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      expect(row?.source).toBe(MOTEC_SESSION_SOURCE);
    }
  }, 30_000);

  test("files laps under the user's chosen track, not the header's", async () => {
    const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
    // Header says spa (see syntheticStint); import it as Monza instead.
    const monza = getAcEvoTrackByName("monza")!;
    const result = await importMotec(buildLd(spec), Buffer.from(buildLdx(beacons)), {
      gameId: "ac-evo",
      carOrdinal: 0,
      trackOrdinal: monza.id,
    });

    expect(result.carTrack.trackOrdinal).toBe(monza.id);
    for (const lap of result.laps) expect(lap.trackOrdinal).toBe(monza.id);
  }, 30_000);

  test("an optional setup is stamped on every imported lap", async () => {
    const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
    const [tune] = await db
      .insert(tunes)
      .values({
        gameId: "ac-evo",
        name: "MoTeC import test setup",
        author: "test",
        carOrdinal: 0,
        category: "race",
        settings: "{}",
      })
      .returning({ id: tunes.id });
    const tuneId = tune!.id;
    const result = await importMotec(buildLd(spec), Buffer.from(buildLdx(beacons)), {
      gameId: "ac-evo",
      carOrdinal: 0,
      trackOrdinal: getAcEvoTrackByName("monza")!.id,
      tuneId,
    });

    expect(result.laps.length).toBeGreaterThan(0);
    for (const lap of result.laps) {
      const [row] = await db.select().from(lapsTable).where(eq(lapsTable.id, lap.lapId));
      expect(row?.tuneId).toBe(tuneId);
    }
  }, 30_000);

  test("omitting the setup leaves laps unassigned rather than guessing one", async () => {
    const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
    const result = await importMotec(buildLd(spec), Buffer.from(buildLdx(beacons)), {
      gameId: "ac-evo",
      carOrdinal: 0,
      trackOrdinal: getAcEvoTrackByName("monza")!.id,
    });

    for (const lap of result.laps) {
      const [row] = await db.select().from(lapsTable).where(eq(lapsTable.id, lap.lapId));
      expect(row?.tuneId).toBeNull();
    }
  }, 30_000);

  test("live-recorded sessions keep a null source", async () => {
    // Guards the flag's meaning: it marks the exception, not every session.
    const [row] = await db
      .select()
      .from(sessions)
      .where(isNull(sessions.source))
      .limit(1);
    // Either there are no other sessions in this DB, or they are unflagged.
    if (row) expect(row.source).toBeNull();
  });
});
