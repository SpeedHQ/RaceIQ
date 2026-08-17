import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getDiscoveredCarName, listDiscoveredCars } from "../../../server/db/discovered-cars";
import {
  getDiscoveredTrackName,
  listDiscoveredTracks,
} from "../../../server/db/discovered-tracks";
import { db } from "../../../server/db/index";
import { discoveredCars, discoveredTracks } from "../../../server/db/schema";
import { initServerGameAdapters } from "../../../server/games/init";
import { registerLiveIRacingIdentity } from "../../../server/games/iracing/identity";
import {
  normalizeIRacingFrame,
} from "../../../server/games/iracing/normalizer";
import {
  canHandleIRacingSourceFrame,
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRACING_MAX_SOURCE_FRAME_SIZE,
  IRACING_SOURCE_SCHEMA_VERSION,
  IRACING_SOURCE_SCHEMA_VERSION_V3,
  IRacingSourceFrameEncoder,
  isIRacingSessionFrame,
  type IRacingSourceFrameV2,
} from "../../../server/games/iracing/source-frame";
import { parsePacket } from "../../../server/games/packet-dispatch";
import { initGameAdapters } from "../../../shared/games/init";
import {
  injectDiscoveredIRacingIdentity,
  iracingAdapter,
} from "../../../shared/games/iracing";

initGameAdapters();
initServerGameAdapters();
import { sampleFrame, sampleFrameV3 } from "../../support/games/iracing-sdk";

describe("iRacing raw source frame parser integration", () => {
  test("persists live source identity once per ordinal for restart hydration", async () => {
    const carOrdinal = 900_042;
    const trackOrdinal = 900_099;

    try {
      await registerLiveIRacingIdentity({
        ...sampleFrame().session,
        carId: carOrdinal,
        carName: "Persisted GT3",
        trackId: trackOrdinal,
        trackName: "Persisted Raceway",
      });
      await registerLiveIRacingIdentity({
        ...sampleFrame().session,
        carId: carOrdinal,
        carName: "Later Rename",
        trackId: trackOrdinal,
        trackName: "Later Track Rename",
      });

      expect(await getDiscoveredCarName("iracing", carOrdinal)).toBe("Persisted GT3");
      expect(await getDiscoveredTrackName("iracing", trackOrdinal)).toBe("Persisted Raceway");
      expect(
        (await listDiscoveredCars("iracing")).filter((row) => row.ordinal === carOrdinal),
      ).toHaveLength(1);
      expect(
        (await listDiscoveredTracks("iracing")).filter((row) => row.ordinal === trackOrdinal),
      ).toHaveLength(1);
      expect(iracingAdapter.getCarName(carOrdinal)).toBe("Persisted GT3");
      expect(iracingAdapter.getTrackName(trackOrdinal)).toBe("Persisted Raceway");

      injectDiscoveredIRacingIdentity(
        await listDiscoveredCars("iracing"),
        await listDiscoveredTracks("iracing"),
      );
      expect(iracingAdapter.getCarName(carOrdinal)).toBe("Persisted GT3");
      expect(iracingAdapter.getTrackName(trackOrdinal)).toBe("Persisted Raceway");
    } finally {
      await db
        .delete(discoveredCars)
        .where(and(
          eq(discoveredCars.gameId, "iracing"),
          eq(discoveredCars.ordinal, carOrdinal),
        ))
        .run();
      await db
        .delete(discoveredTracks)
        .where(and(
          eq(discoveredTracks.gameId, "iracing"),
          eq(discoveredTracks.ordinal, trackOrdinal),
        ))
        .run();
    }
  });

  test("round-trips a self-contained frame through central parsePacket", () => {
    const raw = new IRacingSourceFrameEncoder().encode(sampleFrame());
    expect(canHandleIRacingSourceFrame(raw)).toBe(true);
    expect(isIRacingSessionFrame(raw)).toBe(true);
    expect(decodeIRacingSourceFrame(raw)).toEqual(sampleFrame());

    const packet = parsePacket(raw);
    expect(packet?.gameId).toBe("iracing");
    expect(packet?.sessionUID).toBe("456:123:2");
    expect(packet?.CarOrdinal).toBe(42);
    expect(packet?.TrackOrdinal).toBe(99);
    expect(packet?.LapNumber).toBe(3);
    expect(packet?.DistanceTraveled).toBeCloseTo(20745);
    expect(packet?.Speed).toBeCloseTo(72.5);
    expect(packet?.Accel).toBe(191);
    expect(packet?.Brake).toBe(51);
    expect(packet?.Steer).toBe(-13);
    expect(packet?.TireTempFL).toBeCloseTo(84);
    expect(packet?.TireCarcassTempFL).toBeCloseTo(84);
    expect(packet?.TireCarcassTempLeftFL).toBe(82);
    expect(packet?.TireCarcassTempMiddleFL).toBe(84);
    expect(packet?.TireCarcassTempRightFL).toBe(86);
    expect(packet?.TireWearFL).toBeCloseTo(0.06);
    expect(packet?.iracing?.incidents).toBe(1);
  });

  test("normalizes iRacing steering and yaw to canonical turn signs", () => {
    const leftFrame = sampleFrame();
    leftFrame.values.Yaw = 0.75;
    leftFrame.values.YawRate = 0.2;
    const rightFrame = sampleFrame();
    rightFrame.values.SteeringWheelAngle = -0.2;
    rightFrame.values.Yaw = -0.75;
    rightFrame.values.YawRate = -0.2;

    expect(normalizeIRacingFrame(leftFrame)).toMatchObject({
      Steer: -13,
      Yaw: -0.75,
      AngularVelocityY: -0.2,
    });
    expect(normalizeIRacingFrame(rightFrame)).toMatchObject({
      Steer: 13,
      Yaw: 0.75,
      AngularVelocityY: 0.2,
    });
  });

  test("keeps historical v2 frames compatible without inventing raw YAML", () => {
    const frame = sampleFrame();
    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(raw.readUInt16LE(4)).toBe(IRACING_SOURCE_SCHEMA_VERSION);
    const decoded = decodeIRacingSourceFrame(raw);
    expect(decoded).toEqual(frame);
    expect(decoded).not.toHaveProperty("sessionInfo");
    expect(decoded).not.toHaveProperty("sessionInfoUpdate");
  });

  test("keeps historical v2 wire bytes stable", () => {
    const frame: IRacingSourceFrameV2 = {
      schemaVersion: 2,
      session: {
        sessionId: 1,
        subSessionId: 2,
        sessionNum: 3,
        driverCarIdx: 4,
        trackId: 5,
        trackName: "T",
        trackLengthM: 6,
        sectorStarts: [0, 0.5],
        carId: 7,
        carName: "C",
        carClassId: 8,
        carClassName: "K",
        engineIdleRpm: 9,
        engineRedlineRpm: 10,
        engineCylinderCount: 11,
      },
      values: { SessionTick: 12 },
    };

    expect(
      new IRacingSourceFrameEncoder().encode(frame).toString("base64"),
    ).toBe(
      "SVJJUQIAAQCLAAAAAAAAAAAA8D8AAAAAAAAAQAAAAAAAAAhAAAAAAAAAEEAAAAAAAAAUQAEAVAAAAAAAABhAAgAAAAAAAAAAAAAAAAAAAOA/AAAAAAAAHEABAEMAAAAAAAAgQAEASwAAAAAAACJAAAAAAAAAJEAAAAAAAAAmQAEACwBTZXNzaW9uVGljawIAAAAAAAAoQA==",
    );
  });

  test("round-trips v3 YAML larger than a u16 with exact UTF-8 bytes", () => {
    const sessionInfo =
      `WeekendInfo:\n  TrackDisplayName: Road America 🏁\n  Notes: ` +
      "é".repeat(40_000) +
      "\n";
    expect(Buffer.byteLength(sessionInfo, "utf8")).toBeGreaterThan(0xffff);
    const frame = sampleFrameV3(sessionInfo, 0x1020_3040);

    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(raw.readUInt16LE(4)).toBe(IRACING_SOURCE_SCHEMA_VERSION_V3);
    expect(raw.length).toBeLessThanOrEqual(IRACING_MAX_SOURCE_FRAME_SIZE);
    expect(IRACING_MAX_SOURCE_FRAME_SIZE).toBeGreaterThan(4 * 1024 * 1024);
    expect(decodeIRacingSourceFrame(raw)).toEqual(frame);
  });

  test("round-trips signed native SessionInfo revisions", () => {
    const frame = sampleFrameV3("WeekendInfo: {}\n", -1);
    const raw = new IRacingSourceFrameEncoder().encode(frame);

    expect(decodeIRacingSourceFrame(raw)).toEqual(frame);
  });

  test("forces v3 session frames when raw YAML content or revision changes", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 12);
    const contentOnly = sampleFrameV3(
      "WeekendInfo:\n  TrackName: roadamerica full\n",
      12,
    );
    const revisionOnly = sampleFrameV3(contentOnly.sessionInfo, 13);

    const firstRaw = encoder.encode(first);
    const contentRaw = encoder.encode(contentOnly);
    const revisionRaw = encoder.encode(revisionOnly);

    expect(isIRacingSessionFrame(firstRaw)).toBe(true);
    expect(isIRacingSessionFrame(contentRaw)).toBe(true);
    expect(isIRacingSessionFrame(revisionRaw)).toBe(true);
    expect(decodeIRacingSourceFrame(firstRaw, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(contentRaw, decoder)).toEqual(contentOnly);
    expect(decodeIRacingSourceFrame(revisionRaw, decoder)).toEqual(revisionOnly);
  });

  test("keeps unchanged v3 ticks compact while retaining YAML decoder state", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrameV3();
    const next = sampleFrameV3();
    next.values = {
      ...next.values,
      SessionTime: 125.5 + 1 / 60,
      SessionTick: 7531,
    };

    const sessionRaw = encoder.encode(first);
    const deltaRaw = encoder.encode(next);
    const unchangedRaw = encoder.encode(next);

    expect(isIRacingSessionFrame(sessionRaw)).toBe(true);
    expect(isIRacingSessionFrame(deltaRaw)).toBe(false);
    expect(deltaRaw.length).toBeLessThan(sessionRaw.length / 10);
    expect(unchangedRaw.length).toBe(14);
    expect(decodeIRacingSourceFrame(deltaRaw)).toBeNull();
    expect(decodeIRacingSourceFrame(sessionRaw, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(deltaRaw, decoder)).toEqual(next);
    expect(decodeIRacingSourceFrame(unchangedRaw, decoder)).toEqual(next);
  });

  test("rejects malformed v3 YAML payload lengths and truncated frames", () => {
    const frame = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 5);
    const raw = new IRacingSourceFrameEncoder().encode(frame);
    const yamlLength = Buffer.byteLength(frame.sessionInfo, "utf8");
    const yamlLengthOffset = raw.length - yamlLength - 4;

    expect(decodeIRacingSourceFrame(raw.subarray(0, raw.length - 1))).toBeNull();
    const invalidYamlLength = Buffer.from(raw);
    invalidYamlLength.writeUInt32LE(yamlLength + 1, yamlLengthOffset);
    expect(decodeIRacingSourceFrame(invalidYamlLength)).toBeNull();
    const invalidUtf8 = Buffer.from(raw);
    invalidUtf8[yamlLengthOffset + 4] = 0xff;
    expect(decodeIRacingSourceFrame(invalidUtf8)).toBeNull();
    const oversizedPayload = Buffer.from(raw);
    oversizedPayload.writeUInt32LE(IRACING_MAX_SOURCE_FRAME_SIZE, 8);
    const unsupportedVersion = Buffer.from(raw);
    unsupportedVersion.writeUInt16LE(4, 4);
    expect(decodeIRacingSourceFrame(unsupportedVersion)).toBeNull();
    expect(decodeIRacingSourceFrame(oversizedPayload)).toBeNull();
    const oversizedYaml = sampleFrameV3(
      "x".repeat(4 * 1024 * 1024 + 1),
      5,
    );
    expect(() =>
      new IRacingSourceFrameEncoder().encode(oversizedYaml),
    ).toThrow(/too large/);
    expect(() =>
      new IRacingSourceFrameEncoder().encode(
        sampleFrameV3(frame.sessionInfo, 0x8000_0000),
      ),
    ).toThrow(/Invalid iRacing SessionInfo revision/);
  });

  test("invalidates decoder state after a malformed session refresh", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const initial = sampleFrameV3("WeekendInfo:\n  TrackName: roadamerica\n", 1);
    const refreshed = sampleFrameV3("WeekendInfo:\n  TrackName: spa\n", 2);
    const next = sampleFrameV3(refreshed.sessionInfo, refreshed.sessionInfoUpdate);
    next.values = { ...next.values, SessionTick: 7531 };

    expect(
      decodeIRacingSourceFrame(encoder.encode(initial), decoder),
    ).toEqual(initial);
    const refreshRaw = encoder.encode(refreshed);
    const deltaRaw = encoder.encode(next);
    const invalidRefresh = Buffer.from(refreshRaw);
    invalidRefresh[refreshRaw.length - Buffer.byteLength(refreshed.sessionInfo)] =
      0xff;

    expect(decodeIRacingSourceFrame(invalidRefresh, decoder)).toBeNull();
    expect(decoder.session).toBeNull();
    expect(decodeIRacingSourceFrame(deltaRaw, decoder)).toBeNull();
  });

  test("normalization never exposes raw v3 YAML on telemetry packets", () => {
    const frame = sampleFrameV3();
    const packet = normalizeIRacingFrame(frame);

    expect(packet).not.toHaveProperty("sessionInfo");
    expect(packet).not.toHaveProperty("sessionInfoUpdate");
    expect(packet.iracing).not.toHaveProperty("sessionInfo");
    expect(packet.iracing).not.toHaveProperty("sessionInfoUpdate");
  });

  test("normalizes iRacing left-positive lateral acceleration onto the canonical axis", () => {
    const frame = sampleFrame();
    frame.values = {
      ...frame.values,
      LatAccel: 4.2,
      VertAccel: 9.8,
      LongAccel: -3.5,
    };

    const packet = normalizeIRacingFrame(frame);

    expect(packet.AccelerationX).toBeCloseTo(-4.2);
    expect(packet.AccelerationY).toBeCloseTo(9.8);
    expect(packet.AccelerationZ).toBeCloseTo(-3.5);
  });

  test("packs normal ticks as value-only deltas", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrame();
    const next = sampleFrame();
    next.values = {
      ...next.values,
      SessionTime: 125.5 + 1 / 60,
      SessionTick: 7531,
    };

    const sessionFrame = encoder.encode(first);
    const deltaFrame = encoder.encode(next);
    const unchangedDeltaFrame = encoder.encode(next);
    expect(isIRacingSessionFrame(sessionFrame)).toBe(true);
    expect(isIRacingSessionFrame(deltaFrame)).toBe(false);
    expect(deltaFrame.length).toBeLessThan(64);
    expect(deltaFrame.length).toBeLessThan(sessionFrame.length / 10);
    expect(unchangedDeltaFrame.length).toBe(14);
    expect(decodeIRacingSourceFrame(deltaFrame)).toBeNull();
    expect(decodeIRacingSourceFrame(sessionFrame, decoder)).toEqual(first);
    expect(decodeIRacingSourceFrame(deltaFrame, decoder)).toEqual(next);
    expect(decodeIRacingSourceFrame(unchangedDeltaFrame, decoder)).toEqual(next);
  });

  test("delta frames preserve detailed native channel names and value shapes", () => {
    const encoder = new IRacingSourceFrameEncoder();
    const decoder = createIRacingSourceDecoderState();
    const first = sampleFrame();
    const next = sampleFrame();
    next.values = {
      ...next.values,
      CarPath: " gt3 evo car ",
      CarIdxOnPitRoad: [false, true, false],
      EngineWarnings: 0x80000002,
      CarIdxLapDistPct: [0.25, 0.625, 0.9375],
      LapDeltaToBestLap: 0.001234567890123,
    };

    expect(decodeIRacingSourceFrame(encoder.encode(first), decoder)).toEqual(
      first,
    );
    expect(decodeIRacingSourceFrame(encoder.encode(next), decoder)).toEqual(
      next,
    );
  });


});