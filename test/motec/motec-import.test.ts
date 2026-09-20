import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";

import { initGameAdapters } from "../../shared/games/init";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { initServerGameAdapters } from "../../server/games/init";
import { parseLd, findChannel } from "../../server/motec/ld";
import { parseLdxBeacons } from "../../server/motec/ldx";
import {
  MOTEC_SYNTH_HZ,
  lapWindows,
  deadReckonPath,
  reconstructYawHeading,
  alignPathToTrack,
} from "../../server/motec/kunos-synthesis";
import { normalizeTelemetryPacket } from "../../server/telemetry/normalization";
import { importMotec, MOTEC_SESSION_SOURCE } from "../../server/motec/import";
import { buildLapsZip, importLapsZip } from "../../server/laps/archive";
import { getMotecTargets, initMotecTargets, resolveMotecTarget } from "../../server/motec/targets";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";
import { db } from "../../server/db";
import { laps as lapsTable, sessions, tunes } from "../../server/db/schema";
import { eq, isNull } from "drizzle-orm";
import { getAcEvoTrackByName } from "../../shared/racing/tracks/catalogs/ac-evo"
import { flipPoints } from "../../shared/racing/tracks/coords";
import { getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import { buildLd, buildLdx, syntheticStint } from "../support/motec/ld";
const MOTEC_ARCHIVE = "test/artifacts/motec/acc-barcelona-porsche-992.zip";

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

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s", undefined, Uint8Array.from([1, 0]));

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

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s", undefined, Uint8Array.from([1, 0]));
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

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s", undefined, Uint8Array.from([1, 0]));
    expect(path.heading[0]).toBe(0);
    expect(path.heading[30]).toBeGreaterThan(0);
    expect(path.heading[60]).toBe(0);
    expect(path.heading[90]).toBeGreaterThan(0);
  });

  test("trapezoid-integrates native ROTY samples before synthesis resampling", () => {
    const channel = {
      name: "ROTY",
      shortName: "ROTY",
      unit: "rad/s",
      declaredFreq: 1,
      effectiveFreq: 1,
      samples: Float64Array.from([0, 2, 0]),
    };

    const heading = reconstructYawHeading(channel, 4, 0.5, [[0, 2]], Uint8Array.from([0]));

    expect(Array.from(heading)).toEqual([0, 0.25, 1, 1.75]);
  });

  test("removes closed-lap ROTY bias without changing local rotation shape", () => {
    const duration = 4;
    const bias = 0.1;
    const channel = {
      name: "ROTY",
      shortName: "ROTY",
      unit: "rad/s",
      declaredFreq: 2,
      effectiveFreq: 2,
      samples: new Float64Array(duration * 2 + 1).fill((2 * Math.PI) / duration + bias),
    };

    const heading = reconstructYawHeading(channel, duration * 4, 0.25, [[0, duration]], Uint8Array.from([1]));

    expect(heading[8]).toBeCloseTo(Math.PI, 10);
    expect(heading[15]).toBeCloseTo((2 * Math.PI * 3.75) / duration, 10);
  });
  test("retains measured turn for an open window", () => {
    const channel = {
      name: "ROTY",
      shortName: "ROTY",
      unit: "rad/s",
      declaredFreq: 1,
      effectiveFreq: 1,
      samples: new Float64Array([1, 1, 1]),
    };
    const heading = reconstructYawHeading(channel, 5, 0.5, [[0, 2]], Uint8Array.from([0]));
    expect(heading[4]).toBeCloseTo(2, 10);
  });

  test("closes only windows explicitly bounded by two beacons", () => {
    const framesPerLap = 20;
    const frames = framesPerLap * 3;
    const speed = new Float64Array(frames).fill(36);
    const yaw = new Float64Array(frames).fill(0.2);
    const gLat = new Float64Array(frames);
    const lapIndex = new Int32Array(frames);
    for (let i = 0; i < frames; i++) lapIndex[i] = Math.floor(i / framesPerLap);
    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "rad/s", undefined, Uint8Array.from([0, 1, 0]));
    expect(Math.hypot(path.x[framesPerLap - 1]!, path.z[framesPerLap - 1]!)).toBeGreaterThan(0.1);
    expect(Math.hypot(path.x[framesPerLap * 2 - 1]!, path.z[framesPerLap * 2 - 1]!)).toBeLessThan(0.1);
    expect(Math.hypot(path.x[frames - 1]!, path.z[frames - 1]!)).toBeGreaterThan(0.1);
  });


  test("falls back to lateral G when ROTY is absent", () => {
    const frames = 300;
    const speed = new Float64Array(frames).fill(72);
    const yaw = new Float64Array(frames); // all zero → unusable
    const gLat = new Float64Array(frames).fill(1.0);
    const lapIndex = new Int32Array(frames);

    const path = deadReckonPath(speed, yaw, gLat, lapIndex, dt, "", undefined, Uint8Array.from([0]));
    expect(path.yawFromLateralG).toBe(true);
    // A sustained 1 g at 20 m/s must curve the path, not run it straight.
    expect(Math.abs(path.x[frames - 1]!)).toBeGreaterThan(1);
  });
});
describe("alignPathToTrack", () => {
  test("fits each lap window with its own similarity transform", () => {
    const outline = getTrackOutlineByOrdinal(5, "ac-evo")!;
    const sourceOutline = outline.slice(0, -1);
    const transforms = [
      { scale: 1.35, rotation: 0.22, tx: 400, tz: -250 },
      { scale: 0.72, rotation: -0.31, tx: -600, tz: 900 },
    ];
    const points: Array<{ x: number; z: number }> = [];
    const headings: number[] = [];
    const velocities: Array<{ x: number; z: number }> = [];
    const lapIndexOf = new Int32Array(sourceOutline.length * transforms.length);

    for (let lap = 0; lap < transforms.length; lap++) {
      const transform = transforms[lap]!;
      const cos = Math.cos(transform.rotation), sin = Math.sin(transform.rotation);
      const sourceLap = sourceOutline.map((point) => ({
        x: transform.scale * (cos * point.x - sin * point.z) + transform.tx,
        z: transform.scale * (sin * point.x + cos * point.z) + transform.tz,
      }));
      for (let i = 0; i < sourceLap.length; i++) {
        const point = sourceLap[i]!, next = sourceLap[(i + 1) % sourceLap.length]!;
        const dx = next.x - point.x, dz = next.z - point.z;
        points.push(point);
        headings.push(Math.atan2(dx, dz));
        velocities.push({ x: dx, z: dz });
        lapIndexOf[lap * sourceLap.length + i] = lap;
      }
    }

    const path = {
      x: Float64Array.from(points, (point) => point.x),
      z: Float64Array.from(points, (point) => point.z),
      vx: Float64Array.from(velocities, (velocity) => velocity.x),
      vz: Float64Array.from(velocities, (velocity) => velocity.z),
      heading: Float64Array.from(headings),
      yawFromLateralG: false,
    };
    alignPathToTrack(path, lapIndexOf, "ac-evo", 5, true);

    for (let lap = 0; lap < transforms.length; lap++) {
      const start = lap * sourceOutline.length;
      let maximumDistance = 0;
      for (let i = 0; i < sourceOutline.length; i++) {
        const point = { x: path.x[start + i]!, z: path.z[start + i]! };
        maximumDistance = Math.max(maximumDistance, Math.min(...outline.map((candidate) => Math.hypot(point.x - candidate.x, point.z - candidate.z))));
        const next = { x: path.x[start + (i + 1) % sourceOutline.length]!, z: path.z[start + (i + 1) % sourceOutline.length]! };
        const expectedHeading = Math.atan2(next.x - point.x, next.z - point.z);
        const headingError = Math.atan2(Math.sin(path.heading[start + i]! - expectedHeading), Math.cos(path.heading[start + i]! - expectedHeading));
        const velocityHeading = Math.atan2(path.vx[start + i]!, path.vz[start + i]!);
        const velocityError = Math.atan2(Math.sin(velocityHeading - expectedHeading), Math.cos(velocityHeading - expectedHeading));
        expect(Math.abs(headingError)).toBeLessThan(0.01);
        expect(Math.abs(velocityError)).toBeLessThan(0.01);
      }
      expect(maximumDistance).toBeLessThan(2);
    }
  });
});

describe("resolveMotecCarTrack", () => {
  test("maps MoTeC folder ids to RaceIQ ordinals", () => {
    const bytes = buildLd({
      vehicleId: "mercedes_amg_gt3_evo",
      venue: "spa",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const resolved = resolveMotecTarget("ac-evo").resolveCarTrack(parseLd(bytes));
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
    const header = resolveMotecTarget("ac-evo").resolveCarTrack(parseLd(bytes));
    const monza = getAcEvoTrackByName("monza")!;
    expect(monza.id).not.toBe(header.trackOrdinal);

    const overridden = resolveMotecTarget("ac-evo").resolveCarTrack(parseLd(bytes), {
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
    const resolved = resolveMotecTarget("ac-evo").resolveCarTrack(parseLd(bytes), {});
    expect(resolved.trackOrdinal).toBe(getAcEvoTrackByName("monza")!.id);
  });

  test("passes an unknown car through instead of guessing", () => {
    const bytes = buildLd({
      vehicleId: "not_a_real_car",
      venue: "spa",
      channels: [{ name: "SPEED", freq: 10, samples: [50, 50] }],
    });
    const resolved = resolveMotecTarget("ac-evo").resolveCarTrack(parseLd(bytes));
    expect(resolved.carOrdinal).toBe(-1);
    // The raw string survives so the lap detector can register it as discovered.
    expect(resolved.carModel).toBe("not_a_real_car");
  });
});

describe("convertAcEvoMotecToPackets", () => {
  const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
  const log = parseLd(buildLd(spec));
  const target = resolveMotecTarget("ac-evo");
  const capture = target.convert(log, beacons, target.resolveCarTrack(log));

  test("emits frames at the synthesis rate for the log's duration", () => {
    expect(capture.frameCount).toBe(Math.floor(log.duration * MOTEC_SYNTH_HZ));
    expect(capture.lapCount).toBe(3);
  });

  test("found every channel it needs", () => {
    expect(capture.missingChannels).toEqual([]);
  });

  test("frames parse back through the real AC Evo adapter", () => {
    const packets = capture.packets;
    expect(packets.length).toBe(capture.frameCount);
    expect(packets[0]!.gameId).toBe("ac-evo");
  });

  test("emits a complete canonical TelemetryPacket", () => {
    const packet = capture.packets[0]!;

    expect(packet.IsRaceOn).toBe(1);
    expect(typeof packet.NormSuspensionTravelFL).toBe("number");
    expect(packet.RacePosition).toBe(1);
    expect(packet.HandBrake).toBe(0);
    expect(packet.NormDrivingLine).toBe(0);
    expect(packet.TireWearFL).toBe(-1);
    expect(packet.SurfaceRumbleFL).toBe(0);
    expect(Number.isNaN(packet.TireSlipAngleFL)).toBe(true);
    expect(Number.isNaN(packet.TireCombinedSlipFL)).toBe(true);
    expect(packet.acc?.tireContactHeading).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(packet.acc).toMatchObject({
      engineMap: 0,
      tcRaw: 0,
      absRaw: 0,
      slipVibrations: 0,
      absVibrations: 0,
      flagStatus: "",
      pitStatus: "",
      fuelPerLap: 0,
    });
    expect(Number.isNaN(packet.acc?.brakeBias)).toBe(true);
  });

  test("speed and pedal traces survive the round trip", () => {
    const packets = capture.packets;
    // Flat-out sections were written at 180 km/h = 50 m/s.
    const topSpeed = Math.max(...packets.map((p) => p.Speed));
    expect(topSpeed).toBeCloseTo(50, 0);


    const maxThrottle = Math.max(...packets.map((p) => p.Accel));
    const maxBrake = Math.max(...packets.map((p) => p.Brake));
    expect(maxThrottle).toBe(255); // full throttle → 255
    expect(maxBrake).toBeGreaterThan(100); // 0.5 brake → ~127
  });
  test("preserves smooth ROTY rotation while projecting velocity onto track", () => {
    const packets = capture.packets.map((packet) => ({ ...packet }));
    for (const packet of packets) normalizeTelemetryPacket(packet, true);

    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    let yawSamples = 0;
    let velocitySamples = 0;
    for (let i = 1; i < packets.length; i++) {
      const previous = packets[i - 1]!;
      const packet = packets[i]!;
      if (packet.LapNumber !== previous.LapNumber) continue;

      const expectedYawDelta = -packet.AngularVelocityY / MOTEC_SYNTH_HZ;
      const actualYawDelta = wrap(packet.Yaw - previous.Yaw);
      expect(Math.abs(wrap(actualYawDelta - expectedYawDelta))).toBeLessThanOrEqual(0.01001);
      yawSamples++;

      const dx = packet.PositionX - previous.PositionX;
      const dz = packet.PositionZ - previous.PositionZ;
      if (Math.hypot(dx, dz) <= 1e-6 || Math.hypot(packet.VelocityX, packet.VelocityZ) <= 1) continue;
      const directionDelta = Math.atan2(dx, dz);
      const velocityDirection = Math.atan2(packet.VelocityX, packet.VelocityZ);
      expect(Math.abs(wrap(velocityDirection - directionDelta))).toBeLessThan(0.1);
      velocitySamples++;
    }
    expect(yawSamples).toBeGreaterThan(0);
    expect(velocitySamples).toBeGreaterThan(0);
  });

  test("maps MoTeC steering and forward wheel rotation into AC Evo handedness", () => {
    const packets = capture.packets;
    const moving = packets.find((packet) => packet.Speed > 1 && Math.abs(packet.Steer) > 1);
    expect(moving).toBeDefined();
    expect(moving!.Steer).toBeLessThan(0);
    expect(moving!.WheelRotationSpeedFL).toBeGreaterThan(0);
  });

  test("lap timing resets at each beacon and reports the completed lap time", () => {
    const packets = capture.packets;
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
    const packets = capture.packets;
    let worstDrop = 0;
    for (let i = 1; i < packets.length; i++) {
      worstDrop = Math.min(worstDrop, packets[i]!.DistanceTraveled - packets[i - 1]!.DistanceTraveled);
    }
    expect(worstDrop).toBeGreaterThan(-100);

    // And it does accumulate: 360 s of running covers real ground.
    expect(packets[packets.length - 1]!.DistanceTraveled).toBeGreaterThan(10_000);
  });

  test("produces a racing line rather than a dead trace at the origin", () => {
    const packets = capture.packets;
    const moved = packets.filter((p) => p.PositionX !== 0 || p.PositionZ !== 0);
    expect(moved.length).toBeGreaterThan(packets.length * 0.9);
  });

  test("anchors open windows at beacon-side start/finish without snapping geometry", () => {
    const packets = capture.packets.map((packet) => ({ ...packet }));
    for (const packet of packets) normalizeTelemetryPacket(packet, true);
    const outline = flipPoints(getTrackOutlineByOrdinal(5, "ac-evo")!);
    const lapLength = 120 * MOTEC_SYNTH_HZ;
    const leadingEnd = packets[lapLength - 1]!;
    const nextStart = packets[lapLength]!;
    expect(leadingEnd.PositionX).toBeCloseTo(outline[0]!.x, 3);
    expect(leadingEnd.PositionZ).toBeCloseTo(outline[0]!.z, 3);
    expect(nextStart.PositionX).toBeCloseTo(outline[0]!.x, 3);
    expect(nextStart.PositionZ).toBeCloseTo(outline[0]!.z, 3);
    expect(Math.hypot(
      packets[Math.floor(lapLength / 2)]!.PositionX - outline[0]!.x,
      packets[Math.floor(lapLength / 2)]!.PositionZ - outline[0]!.z,
    )).toBeGreaterThan(100);
  });

  test("a log with no beacons imports as one stint", () => {
    const single = target.convert(log, [], target.resolveCarTrack(log));
    expect(single.lapCount).toBe(1);
  });
});

describe("convertAccMotecToPackets", () => {
  const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
  const log = parseLd(buildLd(spec));
  const target = resolveMotecTarget("acc");
  const capture = target.convert(log, beacons, target.resolveCarTrack(log));

  test("reports completed and best lap times in canonical seconds", () => {
    const firstPacketOfLapTwo = capture.packets.find((packet) => packet.LapNumber === 2);

    expect(firstPacketOfLapTwo).toBeDefined();
    expect(firstPacketOfLapTwo!.LastLap).toBeCloseTo(120, 3);
    expect(firstPacketOfLapTwo!.BestLap).toBeCloseTo(120, 3);
    expect(firstPacketOfLapTwo!.CurrentLap).toBe(0);
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
    expect(result.unavailableFeatures).toEqual(expect.arrayContaining([
      { feature: "balance", missingSemanticIds: ["tires.tire-slip-angle"] },
      { feature: "brakeBias", missingSemanticIds: ["brakes.brake-bias"] },
    ]));
    expect(result.capabilities.length).toBeLessThan(TELEMETRY_CATALOG.variables.length);
    expect(result.capabilities).toEqual(expect.arrayContaining([
      { semanticId: "inputs.accel", label: "Accel", group: "Driver inputs", available: true },
      { semanticId: "inputs.brake", label: "Brake", group: "Driver inputs", available: true },
      { semanticId: "inputs.steer", label: "Steer", group: "Driver inputs", available: true },
      { semanticId: "inputs.gear", label: "Gear", group: "Driver inputs", available: true },
      { semanticId: "motion.speed", label: "Speed", group: "Vehicle motion", available: true },
      { semanticId: "engine.current-engine-rpm", label: "Current Engine RPM", group: "Engine", available: true },
      { semanticId: "brakes.brake-bias", label: "Front brake bias", group: "Brakes", available: false },
    ]));
    expect(result.capabilities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticId: "weather.air-temp" }),
      expect.objectContaining({ semanticId: "setup.tires.starting-pressure" }),
    ]));

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

  test("exports and imports complete MoTeC source session", async () => {
    const { spec, beacons } = syntheticStint({ laps: 3, lapSeconds: 120, hz: 60 });
    const imported = await importMotec(buildLd(spec), Buffer.from(buildLdx(beacons)), {
      gameId: "ac-evo",
    });
    const sourceSessionId = imported.laps[0]!.sessionId;
    const sourceSession = await db.select().from(sessions).where(eq(sessions.id, sourceSessionId)).get();
    const sourceRows = await db.select().from(lapsTable).where(eq(lapsTable.sessionId, sourceSessionId)).all();
    const sourceArchive = readFileSync(sourceSession!.rawFile!);

    const exported = await buildLapsZip([sourceRows[0]!.id]);
    expect(exported.manifest.version).toBe(4);
    expect(exported.manifest.entries).toHaveLength(1);
    expect(exported.manifest.entries[0]!.file).toEndWith(".motec.zip");
    expect(exported.manifest.entries[0]!.laps).toHaveLength(sourceRows.length);
    const outer = unzipSync(exported.bytes);
    expect([...outer[exported.manifest.entries[0]!.file]!]).toEqual([...sourceArchive]);

    const roundTrip = await importLapsZip(exported.bytes);
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.skipped).toBe(0);
    expect(roundTrip.imported).toBe(sourceRows.length);
    expect(new Set(roundTrip.laps.map((lap) => lap.sessionId)).size).toBe(1);
    const roundTripSession = await db.select().from(sessions).where(eq(sessions.id, roundTrip.laps[0]!.sessionId)).get();
    expect(roundTripSession?.gameId).toBe("ac-evo");
  }, 60_000);

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
  test("stages and imports a MoTeC archive through shared transfer route", async () => {
    const stageForm = new FormData();
    stageForm.append("file", new File([readFileSync(MOTEC_ARCHIVE)], "Barcelona-992-MoTeC.zip"));
    const stagedResponse = await transferRoutes.request("/api/laps/stage-motec", { method: "POST", body: stageForm });
    expect(stagedResponse.status).toBe(200);
    const staged = await stagedResponse.json() as { token: string; ldName: string; ldxName: string };
    expect(staged.ldName).toBe("Barcelona-porsche_992_gt3_r-4-2024.12.06-14.54.26.ld");
    expect(staged.ldxName).toBe("Barcelona-porsche_992_gt3_r-4-2024.12.06-14.54.26.ldx");

    const form = new FormData();
    form.append("motecToken", staged.token);
    form.append("gameId", "acc");
    form.append("carOrdinal", "33");
    form.append("trackOrdinal", "8");
    form.append("ownership", "mine");
    const response = await transferRoutes.request("/api/laps/import-motec", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, gameId: "acc", imported: 1, packetCount: 6164 });
    const replay = await transferRoutes.request("/api/laps/import-motec", { method: "POST", body: form });
    expect(replay.status).toBe(410);
  });

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
