import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { parseLd, findChannel } from "../../server/motec/ld";
import { parseLdxBeacons } from "../../server/motec/ldx";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";
import { importMotec } from "../../server/motec/import";
import { resolveMotecTarget } from "../../server/motec/targets";
import { normalizeTelemetryPacket } from "../../server/telemetry/normalization";
import { MOTEC_STEER_LOCK_DEG, MOTEC_SYNTH_HZ } from "../../server/motec/kunos-synthesis";
import { getTrackOutlineByOrdinal } from "../../shared/racing/tracks/recording/outlines";

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
    const carTrack = resolveMotecTarget("acc").resolveCarTrack(log, { carOrdinal: 33, trackOrdinal: 8 });
    const capture = resolveMotecTarget("acc").convert(log, beacons, carTrack);
    expect(capture.frameCount).toBe(6164);
    expect(capture.lapCount).toBe(1);
    expect(capture.missingChannels).toEqual([]);
    expect(capture.yawFromLateralG).toBe(false);
    const packets = capture.packets;
    expect(packets).toHaveLength(6164);
    expect(packets[0]!.acc?.tireRadius).toEqual([0, 0, 0, 0]);
    expect(packets[0]!.acc?.absVibrations).toBe(0);
    const normalizedPackets = packets.map((packet) => ({ ...packet }));
    for (const packet of normalizedPackets) normalizeTelemetryPacket(packet, true);
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    let yawSamples = 0;
    let maxAbsYaw = 0;
    for (let i = 0; i < normalizedPackets.length; i++) {
      const packet = normalizedPackets[i]!;
      maxAbsYaw = Math.max(maxAbsYaw, Math.abs(packet.Yaw));
      if (i === 0) continue;
      const previous = normalizedPackets[i - 1]!;
      if (packet.LapNumber !== previous.LapNumber) continue;
      const expectedYawDelta = -packet.AngularVelocityY / MOTEC_SYNTH_HZ;
      const actualYawDelta = wrap(packet.Yaw - previous.Yaw);
      expect(Math.abs(wrap(actualYawDelta - expectedYawDelta))).toBeLessThanOrEqual(0.01001);
      const horizontalSpeed = Math.hypot(packet.VelocityX, packet.VelocityZ);
      if (horizontalSpeed <= 1) continue;
      const velocityDirection = Math.atan2(packet.VelocityX, packet.VelocityZ);
      expect(Math.abs(wrap(packet.Yaw - velocityDirection))).toBeLessThan(0.1);
      yawSamples++;
    }
    expect(yawSamples).toBeGreaterThan(0);
    expect(maxAbsYaw).toBeGreaterThan(0.1);
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
      const steer = findChannel(log, "STEERANGLE")!.samples[Math.round(frameIndex / 60 * findChannel(log, "STEERANGLE")!.effectiveFreq)]!;
      const expectedSteer = Math.round(Math.max(-1, Math.min(1, -steer / MOTEC_STEER_LOCK_DEG)) * 127) || 0;
      expect(packet.Steer).toBeCloseTo(expectedSteer, 10);
      const suspension = findChannel(log, "SUS_TRAVEL_LF")!.samples[Math.round(frameIndex / 60 * findChannel(log, "SUS_TRAVEL_LF")!.effectiveFreq)]!;
      expect(packet.SuspensionTravelMFL).toBeCloseTo(suspension / 1000, 5);
    }

    const outline = getTrackOutlineByOrdinal(8, "acc");
    expect(outline).not.toBeNull();
    expect(packets[0]!.PositionX).toBeCloseTo(outline![0]!.x, 3);
    expect(packets[0]!.PositionZ).toBeCloseTo(outline![0]!.z, 3);

    let pathLengthM = 0;
    for (let i = 1; i < packets.length; i++) {
      pathLengthM += Math.hypot(
        packets[i]!.PositionX - packets[i - 1]!.PositionX,
        packets[i]!.PositionZ - packets[i - 1]!.PositionZ,
      );
    }
    expect(pathLengthM).toBeGreaterThan(4_000);

    const deviations: number[] = [];
    for (let i = 0; i < packets.length; i += 10) {
      let nearest = Infinity;
      for (const point of outline!) {
        nearest = Math.min(nearest, Math.hypot(
          packets[i]!.PositionX - point.x,
          packets[i]!.PositionZ - point.z,
        ));
      }
      deviations.push(nearest);
    }
    const meanDeviationM = deviations.reduce((sum, deviation) => sum + deviation, 0) / deviations.length;
    expect(meanDeviationM).toBeLessThan(10);
    expect(Math.max(...deviations)).toBeLessThan(30);
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

  test("rejects MoTeC imports without the signal sidecar", async () => {
    await expect(importMotec(fixture.ld, undefined, {
      gameId: "acc",
      carOrdinal: 33,
      trackOrdinal: 8,
    })).rejects.toThrow("MoTeC .ldx signal file is required");
  });

  test("stages and imports an ACC MoTeC archive through the transfer route", async () => {
    const stageForm = new FormData();
    stageForm.append("file", new File([readFileSync(FIXTURE)], "Barcelona-992-MoTeC.zip"));
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
  });
});
