import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { unlinkSync } from "fs";
import { gzipSync } from "zlib";
import { initServerGameAdapters } from "../server/games/init";
import {
  IRacingSourceFrameEncoder,
  type IRacingSourceFrameV2,
} from "../server/games/iracing/source-frame";
import { deleteSession, insertSession, updateSessionRawFile } from "../server/db/session-queries";
import { insertLap } from "../server/db/lap-mutation-queries";
import { queryLapTelemetryBySemanticId } from "../server/telemetry-replay";
import { META_FRAME_MAGIC } from "../server/session-capture/framing"
import { canonicalizeTelemetryScalar } from "../shared/telemetry-replay";
import { initGameAdapters } from "../shared/games/init";

initGameAdapters();
initServerGameAdapters();

function frame(sessionTick: number, sessionState: number): IRacingSourceFrameV2 {
  return {
    schemaVersion: 2,
    session: {
      sessionId: 202,
      subSessionId: 205,
      sessionNum: 1,
      driverCarIdx: 0,
      trackId: 99,
      trackName: "Replay Test Track",
      trackLengthM: 5000,
      sectorStarts: [0, 0.5],
      carId: 42,
      carName: "Replay Test Car",
      carClassId: 8,
      carClassName: "GT3",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: {
      SessionTick: sessionTick,
      SessionTime: sessionTick / 60,
      SessionNum: 1,
      SessionState: sessionState,
      IsOnTrack: true,
      Speed: 72.5,
      Lap: 1,
      LapDist: 100,
      LapDistPct: 0.02,
    },
  };
}

function record(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
}

test("canonical replay values clone recursive boolean and string structures", () => {
  const source = {
    flags: [true, false],
    labels: ["primary", "alternate"],
    nested: { samples: [1, null] },
  };
  const canonical = canonicalizeTelemetryScalar(
    source,
    "diagnostics.test-structure",
  );
  expect(canonical).toEqual(source);
  expect(canonical).not.toBe(source);
  source.flags[0] = false;
  expect(canonical).toEqual({
    flags: [true, false],
    labels: ["primary", "alternate"],
    nested: { samples: [1, null] },
  });
  expect(() =>
    canonicalizeTelemetryScalar(
      { invalid: Number.NaN },
      "diagnostics.test-structure",
    )
  ).toThrow("contains a non-finite number");
});

test("semantic replay aligns native session frames and hashes decompressed capture bytes", async () => {
  const encoder = new IRacingSourceFrameEncoder();
  const sessionFrame = encoder.encode(frame(1, 2));
  const telemetryFrame = encoder.encode(frame(2, 4));
  const meta = Buffer.alloc(12);
  meta.writeUInt32LE(META_FRAME_MAGIC, 0);
  meta.writeUInt32LE(4, 4);
  const rawByteOffset = meta.length;
  const capture = Buffer.concat([meta, record(sessionFrame), record(telemetryFrame)]);
  const rawFile = `${process.env.DATA_DIR ?? "."}/semantic-replay-${Date.now()}.bin.gz`;
  await Bun.write(rawFile, gzipSync(capture));

  const sessionId = await insertSession(42, 99, "iracing");
  try {
    await updateSessionRawFile(sessionId, rawFile, "test-detector");
    const lapId = await insertLap(
      sessionId,
      1,
      1,
      true,
      rawByteOffset,
      2,
    );

    const replay = await queryLapTelemetryBySemanticId(lapId, [
      "session.session-state",
      "motion.speed",
    ]);
    expect(replay?.envelopes).toHaveLength(2);
    expect(
      replay?.envelopes.map((envelope) =>
        envelope.values.find(
          (value) => value.semanticId === "session.session-state",
        )?.value
      ),
    ).toEqual([2, 4]);
    expect(replay?.envelopes[0].values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticId: "motion.speed",
          value: 72.5,
          state: "ok",
        }),
      ]),
    );
    const expectedHash =
      `sha256:${createHash("sha256").update(capture).digest("hex")}`;
    for (const envelope of replay?.envelopes ?? []) {
      expect(envelope.rawReference).toEqual({
        objectId: `session:${sessionId}:raw-capture`,
        contentHash: expectedHash,
        contentEncoding: "identity",
        storageEncoding: "gzip",
        byteOffset: rawByteOffset,
        frameCount: 2,
      });
    }
  } finally {
    await deleteSession(sessionId);
    try {
      unlinkSync(rawFile);
    } catch {}
  }
});
