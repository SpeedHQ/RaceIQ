import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeFrameLength, encodeMetaFrame, encodeSessionClockAnchor, encodeSparseCaptureFormatFrame, iterateSessionCaptureRecords,
  type PortableCaptureIdentity, type PortableLapIdentity } from "@raceiq/capture-formats/session/framing";
import { updateNativeRecordDigest } from "@raceiq/capture-splitting";
import { validatePortableCaptureIdentity } from "../../session-capture/portable-identity";

function fixture() {
  const parts = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
  const offsets: number[] = [];
  let offset = parts.reduce((sum, part) => sum + part.length, 0);
  for (let index = 0; index < 4; index++) {
    const frame = Buffer.from([index, 20, 30, 40]);
    offsets.push(offset);
    const prefix = encodeFrameLength(frame.length, 1_800_000_000_000 + index);
    parts.push(prefix, frame);
    offset += prefix.length + frame.length;
  }
  const bytes = Buffer.concat(parts);
  const hash = createHash("sha256");
  let records = 0;
  for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
    updateNativeRecordDigest(hash, record);
    records++;
  }
  const lap = (index: number): PortableLapIdentity => ({
    lapGuid: index === 0 ? "019a08b0-0000-7000-8000-000000000001" : "019a08b0-0000-7000-8000-000000000002",
    lapGuidStatus: "resolved",
    lapNumber: index + 1, lapTime: 60, isValid: true, invalidReason: null,
    rawByteOffset: offsets[index * 2]!, rawFrameCount: 2, sectorTimes: [20, 20, 20], totalTimeMs: 60_000,
    sectorTimesMs: [20_000, 20_000, 20_000], recordedAt: null, createdAt: "2026-10-20 00:00:00",
    driverAttribution: "Unknown", driverAttributionStints: null,
    sourceClockDomain: "native-session", sourceLapStartMs: index * 60_000, sourceLapEndMs: (index + 1) * 60_000,
  });
  const laps = [lap(0), lap(1)];
  const identity: PortableCaptureIdentity = {
    schemaVersion: 1, originalActivityId: "019a08b0-0000-7000-8000-000000000003", ownerUserId: "portable-source-owner",
    sourceRevision: "captured-source-revision",
    sourceAuthorUserId: null, sourceAuthorDisplayName: null, ownership: "mine",
    representation: { coordinates: "capture-byte-v1", contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, kind: "original" },
    originalSource: { coordinates: "native-record-v1", sourceRevision: "captured-source-revision", originalLapGuids: laps.map((lap) => lap.lapGuid!),
      sourceRecordCount: records, nativeRecordHash: `sha256:${hash.digest("hex")}` },
    session: { createdAt: "2026-10-20 00:00:00", sessionType: "race", driverAttribution: "Unknown", driverAttributionStints: null }, laps,
  };
  return { bytes, identity, offsets };
}

test("a recomputed wrapper hash and record count cannot promote a truncated original", () => {
  const { bytes, identity, offsets } = fixture();
  const truncated = bytes.subarray(0, offsets[3]);
  identity.representation.contentHash = `sha256:${createHash("sha256").update(truncated).digest("hex")}`;
  identity.originalSource!.sourceRecordCount = 3;
  identity.laps[1]!.rawFrameCount = 1;
  expect(() => validatePortableCaptureIdentity(truncated, identity)).toThrow("Portable original source membership is incomplete");
});

test("a one-lap copy cannot retain a full original membership descriptor", () => {
  const { bytes, identity } = fixture();
  identity.laps.pop();
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Portable original source membership is incomplete");
});

test("overlapping source windows do not become two original laps", () => {
  const { bytes, identity, offsets } = fixture();
  identity.laps[1]!.rawByteOffset = offsets[1]!;
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Portable lap frame windows overlap");
});

test("duplicate original GUIDs are rejected even when all source records are present", () => {
  const { bytes, identity } = fixture();
  identity.laps[1]!.lapGuid = identity.laps[0]!.lapGuid;
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Duplicate or noncanonical portable lap GUID");
});

test("downsampled representations cannot carry a complete original descriptor", () => {
  const { bytes, identity } = fixture();
  identity.representation.kind = "downsample";
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Transformed portable capture cannot claim complete original coverage");
});

for (const gap of ["missing", "unresolved"] as const) {
  test(`${gap} lap GUID membership cannot finalize a portable original`, () => {
    const { bytes, identity } = fixture();
    if (gap === "missing") identity.laps[0]!.lapGuid = null;
    else identity.laps[0]!.lapGuidStatus = "held_ambiguous";
    expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Portable original source membership is incomplete");
  });
}

test("a completion marker does not permit overlapping owned source frames", () => {
  const { bytes, identity } = fixture();
  identity.laps[0]!.rawFrameCount = 4;
  identity.laps[0]!.trailingContextFrameCount = 1;
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Portable lap frame windows overlap");
});

test("an empty selected copy cannot invent complete activity membership", () => {
  const { bytes, identity } = fixture();
  identity.laps = [];
  identity.representation.kind = "partial";
  identity.originalSource = null;
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Empty portable capture requires complete original source proof");
});

test("a partial copy cannot replace full original scalar duration", () => {
  const { bytes, identity } = fixture();
  identity.representation.kind = "partial";
  identity.originalSource = null;
  identity.session.duration = { status: "available", elapsedSeconds: 12,
    attribution: { selfSeconds: 4, otherSeconds: 3, unknownSeconds: 5, selfObserved: true, coverage: "partial" } };
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Partial portable capture cannot replace original duration facts");
});

test("a relative anchor cannot be relabelled as an identity UTC frame clock", () => {
  const { bytes, identity } = fixture();
  identity.session.frameClock = "capture_utc";
  identity.session.clockAnchor = { frameTimeMs: 10, utcTimeMs: 20 };
  expect(() => validatePortableCaptureIdentity(bytes, identity)).toThrow("Portable UTC frame-clock mapping conflicts with its source anchor");
});

test("malformed or misplaced clock anchors cannot enter captured source history", () => {
  const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
  const anchor = encodeSessionClockAnchor(10, 1_800_000_000_000);
  const frame = Buffer.concat([encodeFrameLength(4, 10), Buffer.from([1, 2, 3, 4])]);
  const unsupported = Buffer.from(anchor);
  unsupported.writeUInt32LE(2, 12);
  for (const bytes of [
    Buffer.concat([header, anchor, anchor, frame]),
    Buffer.concat([header, anchor.subarray(0, 20)]),
    Buffer.concat([header, unsupported, frame]),
    Buffer.concat([header, frame, anchor]),
  ]) {
    expect(() => [...iterateSessionCaptureRecords(bytes, undefined, { strict: true })]).toThrow();
  }
});
