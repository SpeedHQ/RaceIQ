import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { deleteSession } from "../../server/db/session-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "../../server/games/lmu/recorder";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { encodeFrameLength, encodeMetaFrame } from "../../server/session-capture/framing";
import { readRecordedTelemetry } from "../../server/session-capture/replay-packets";

import { developmentReleaseFeatures } from "../../scripts/release/development-release-features";
const fixturePath = "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz";
const directories: string[] = [];
const sessionIds: number[] = [];


beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function canonicalCapture(frames: Buffer[]): Buffer {
  return Buffer.concat([
    encodeMetaFrame(frames.length),
    ...frames.flatMap((frame) => [encodeFrameLength(frame.length), frame]),
  ]);
}

function packetEvidence(path: string) {
  return readRecordedTelemetry("lmu", path).packets.map((packet) => ({
    lap: packet.LapNumber,
    distance: packet.DistanceTraveled,
    carId: packet.lmu?.carId,
    trackId: packet.lmu?.trackId,
  }));
}

describe("LMU capture containers", () => {
  test("replays LMUQDMP and canonical RQLMUSF framing identically, plain and gzip", async () => {
    const dump = Buffer.from(gunzipSync(readFileSync(fixturePath)));
    expect(hasLMUDumpMagic(dump)).toBe(true);
    const frames = readLMUFramesFromBuffer(dump);
    expect(frames.length).toBeGreaterThan(100);
    const canonical = canonicalCapture(frames);
    expect(hasLMUDumpMagic(canonical)).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-containers-"));
    directories.push(directory);
    const paths = {
      dump: join(directory, "lmu-dump.bin"),
      dumpGzip: join(directory, "lmu-dump.bin.gz"),
      canonical: join(directory, "lmu-canonical.bin"),
      canonicalGzip: join(directory, "lmu-canonical.bin.gz"),
    };
    writeFileSync(paths.dump, dump);
    writeFileSync(paths.dumpGzip, gzipSync(dump));
    writeFileSync(paths.canonical, canonical);
    writeFileSync(paths.canonicalGzip, gzipSync(canonical));

    const expected = packetEvidence(paths.dump);
    expect(expected.length).toBe(frames.length);
    expect(packetEvidence(paths.dumpGzip)).toEqual(expected);
    expect(packetEvidence(paths.canonical)).toEqual(expected);
    expect(packetEvidence(paths.canonicalGzip)).toEqual(expected);
    expect(expected[0]).toMatchObject({
      carId: expect.any(String),
      trackId: expect.any(String),
    });

    const imported = await importSessionBin(canonical, "lmu", { requireLaps: true, notifyDriverProfile: false });
    expect(imported.packetCount).toBeGreaterThan(0);
    expect(imported.laps.length).toBeGreaterThan(0);
    expect(imported.laps.every((lap) => typeof lap.carId === "string" && typeof lap.trackId === "string")).toBe(true);
    for (const id of new Set(imported.laps.map((lap) => lap.sessionId))) sessionIds.push(id);
    const row = await db.select().from(sessions).where(eq(sessions.id, imported.laps[0]!.sessionId)).get();
    expect(row).toMatchObject({
      gameId: "lmu",
      carOrdinal: -1,
      trackOrdinal: -1,
      carId: expect.any(String),
      trackId: expect.any(String),
    });
  }, 60_000);
});
