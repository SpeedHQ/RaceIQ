import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing";
import { unzipSync } from "fflate";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { parseLd, findChannel } from "../../server/motec/ld";
import { parseLdxBeacons } from "../../server/motec/ldx";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { importMotec } from "../../server/motec/import";
import { synthesizeAccCapture } from "../../server/games/acc/motec";

const FIXTURE = "test/artifacts/motec/acc-barcelona-porsche-992.zip";

type AccFixture = { ld: Buffer; ldx: Buffer };

function loadAccFixture(): AccFixture {
  const members = unzipSync(readFileSync(FIXTURE));
  const ldNames = Object.keys(members).filter((name) => name.endsWith(".ld"));
  const ldxNames = Object.keys(members).filter((name) => name.endsWith(".ldx"));
  if (ldNames.length !== 1 || ldxNames.length !== 1) {
    throw new Error(`Expected exactly one .ld and one .ldx in ${FIXTURE}`);
  }
  return {
    ld: Buffer.from(members[ldNames[0]!]!),
    ldx: Buffer.from(members[ldxNames[0]!]!),
  };
}

function* iterateFrames(bin: Buffer): Generator<Buffer> {
  let offset = bin.readUInt32LE(0) === META_FRAME_MAGIC ? 12 : 0;
  while (offset + 4 <= bin.length) {
    const length = bin.readUInt32LE(offset);
    offset += 4;
    if (length <= 0 || offset + length > bin.length) break;
    yield bin.subarray(offset, offset + length);
    offset += length;
  }
}

function parseFrames(bin: Buffer) {
  const game = getServerGame("acc");
  const packets = [];
  for (const frame of iterateFrames(bin)) {
    const packet = game.tryParse(frame, game.createParserState?.() ?? null);
    if (packet) packets.push(packet);
  }
  return packets;
}

initGameAdapters();
initServerGameAdapters();

describe("ACC MoTeC real recording", () => {
  const fixture = loadAccFixture();
  const log = parseLd(fixture.ld);
  const beacons = parseLdxBeacons(fixture.ldx.toString("utf8"));

  test("parses approved archive metadata and channel rates", () => {
    expect(log.venue).toBe("Barcelona");
    expect(log.duration).toBeCloseTo(102.74, 2);
    expect(log.channels).toHaveLength(55);
    expect(findChannel(log, "SPEED")?.effectiveFreq).toBe(60);
    expect(findChannel(log, "THROTTLE")?.effectiveFreq).toBe(60);
    expect(findChannel(log, "BRAKE")?.effectiveFreq).toBe(60);
    expect(findChannel(log, "STEERANGLE")?.effectiveFreq).toBe(60);
    expect(findChannel(log, "RPMS")?.effectiveFreq).toBe(60);
    expect(findChannel(log, "G_LAT")?.effectiveFreq).toBe(20);
    expect(findChannel(log, "G_LON")?.effectiveFreq).toBe(20);
    expect(findChannel(log, "ROTY")?.effectiveFreq).toBe(20);
    expect(findChannel(log, "GEAR")?.effectiveFreq).toBe(20);
    expect(findChannel(log, "SUS_TRAVEL_LF")?.effectiveFreq).toBe(200);
    expect(findChannel(log, "SPEED")?.unit).toBe("m/s");
    expect(findChannel(log, "THROTTLE")?.unit).toBe("%");
    expect(findChannel(log, "STEERANGLE")?.unit).toBe("deg");
    expect(findChannel(log, "ROTY")?.unit).toBe("rad/s");
    expect(findChannel(log, "SUS_TRAVEL_LF")?.unit).toBe("mm");
  });

  test("round-trips real samples through ACC adapter", () => {
    const capture = synthesizeAccCapture(log, beacons, { carOrdinal: 33, trackOrdinal: 8 });
    expect(capture.frameCount).toBe(6164);
    expect(capture.lapCount).toBe(1);
    expect(capture.missingChannels).toEqual([]);
    expect(capture.yawFromLateralG).toBe(false);
    const packets = parseFrames(capture.bin);
    expect(packets).toHaveLength(6164);
    for (const packet of packets) {
      expect(packet.gameId).toBe("acc");
      expect(packet.CarOrdinal).toBe(33);
      expect(packet.TrackOrdinal).toBe(8);
    }
    for (const frameIndex of [0, 1500, 3000, 6000]) {
      const packet = packets[frameIndex]!;
      const sourceIndex = Math.round(frameIndex / 60 * findChannel(log, "SPEED")!.effectiveFreq);
      expect(packet.Speed).toBeCloseTo(findChannel(log, "SPEED")!.samples[sourceIndex]!, 3);
      const throttle = findChannel(log, "THROTTLE")!.samples[Math.round(frameIndex / 60 * findChannel(log, "THROTTLE")!.effectiveFreq)]!;
      const brake = findChannel(log, "BRAKE")!.samples[Math.round(frameIndex / 60 * findChannel(log, "BRAKE")!.effectiveFreq)]!;
      expect(packet.Accel).toBe(Math.round(throttle * 2.55));
      expect(packet.Brake).toBe(Math.round(brake * 2.55));
      expect(packet.CurrentEngineRpm).toBe(Math.round(findChannel(log, "RPMS")!.samples[Math.round(frameIndex / 60 * findChannel(log, "RPMS")!.effectiveFreq)]!));
      expect(packet.Gear).toBe(Math.round(findChannel(log, "GEAR")!.samples[Math.round(frameIndex / 60 * findChannel(log, "GEAR")!.effectiveFreq)]!));
      const suspension = findChannel(log, "SUS_TRAVEL_LF")!.samples[Math.round(frameIndex / 60 * findChannel(log, "SUS_TRAVEL_LF")!.effectiveFreq)]!;
      expect(packet.SuspensionTravelMFL).toBeCloseTo(suspension / 1000, 5);
    }
  });

  test("imports one ACC lap under MoTeC source", async () => {
    const result = await importMotec(fixture.ld, fixture.ldx, {
      gameId: "acc",
      carOrdinal: 33,
      trackOrdinal: 8,
    });
    expect(result.gameId).toBe("acc");
    expect(result.packetCount).toBe(6164);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]?.lapTime).toBeGreaterThan(100);
    expect(result.laps[0]?.lapTime).toBeLessThan(104);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, result.laps[0]!.sessionId));
    expect(session?.gameId).toBe("acc");
    expect(session?.source).toBe("motec");
  });
});
