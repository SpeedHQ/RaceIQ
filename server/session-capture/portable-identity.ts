import type { Transaction } from "@libsql/client/sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { client, readClient, readDb } from "../db/index";
import { laps, sessions, lapGuidReconciliation, liveCaptures, liveCaptureMembers } from "../db/schema";
import { bindAuthoritativeLapGuidInTransaction } from "../db/lap-guid";
import { bindOriginalActivityNativeSourceHash, readOriginalActivitySourceProof, registerVerifiedPortableOriginalInTransaction, retainOriginalLapIdentityInTransaction } from "../db/original-activity-queries";
import { enqueueSessionCaptureSplit } from "../db/session-queries";
import { DASHBOARD_PROCESSOR_VERSION } from "../db/dashboard-summary-queries";
import { dashboardDurationAttribution } from "../driver-summary/dashboard-input";
import { withDatabaseTransaction } from "../db/write-coordination";
import { resolveRecordingGameDirectory } from "../runtime/config/recording-directory";
import type { GameId } from "@raceiq/shared/games/ids";
import { LAP_CLASSIFICATIONS } from "@raceiq/shared/racing/lap-classification";
import { containsSparseCaptureFrames, decompressIfGzipSync, encodeFrameLength, encodeMetaFrame,
  encodeSessionMetadataRecord, encodeSparseCaptureFormatFrame,
  iterateSessionCaptureRecords, MAX_DECOMPRESSED_CAPTURE_BYTES,
  type PortableCaptureIdentity, type PortableLapIdentity, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { iterateOriginalCapturePartRecords, loadCaptureManifest, resolveLiveLapCaptureArtifact, type SessionCapturePart } from "./source-loader";
import type { ImportedLap } from "./import-pipeline";
import { notifyOnlineSync } from "@raceiq/online/sync-events";
import { markDashboardCaptureCheckpoint, processDashboardSession } from "./dashboard-processor";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { Schema } from "effect";
import { LiveArchiveMemberSchema, updateNativeRecordDigest } from "@raceiq/capture-splitting";
import { detectGameIdFromBuffer } from "./import-capture";
import { stintSchema } from "./portable-metadata";
import { recordedCaptureFrameClock, recordedCaptureClockAnchor } from "./frame-time";

const finite = z.number().finite();
const count = z.number().int().nonnegative().safe();
const attribution = z.enum(["Self", "Other", "Mixed", "Unknown"]);
const lapClassificationSchema = z.enum(LAP_CLASSIFICATIONS).nullable();
const clockAnchorSchema = z.object({ frameTimeMs: count, utcTimeMs: count.max(8_640_000_000_000_000) }).strict();
const durationSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  elapsedSeconds: finite.nonnegative().nullable(),
  attribution: z.object({ selfSeconds: finite.nonnegative(), otherSeconds: finite.nonnegative(), unknownSeconds: finite.nonnegative(),
    selfObserved: z.boolean(), coverage: z.enum(["complete", "partial", "unavailable"]) }).strict().nullable(),
}).strict().refine((value) => (value.status === "available") === (value.elapsedSeconds !== null)
  && (value.attribution === null || ((value.attribution.selfObserved || value.attribution.selfSeconds === 0)
    && (value.attribution.coverage !== "complete" || value.attribution.unknownSeconds === 0))), "Invalid original duration facts");
const lapSchema = z.object({ lapGuid: z.string().uuid().nullable(), lapNumber: count, lapTime: finite, isValid: z.boolean(), invalidReason: z.string().nullable(),
  lapGuidStatus: z.enum(["resolved", "held_ambiguous"]),
  classification: lapClassificationSchema.default(null),
  rawByteOffset: count, rawFrameCount: count.positive(), sectorTimes: z.array(finite).nullable(), recordedAt: z.string().nullable(), createdAt: z.string().min(1),
  trailingContextFrameCount: count.max(1).optional(),
  totalTimeMs: z.number().int().safe().nullable(), sectorTimesMs: z.array(z.number().int().safe()).nullable(),
  driverAttribution: attribution.nullable(), driverAttributionStints: z.array(stintSchema).nullable(), sourceClockDomain: z.string().nullable(), sourceLapStartMs: finite.nullable(), sourceLapEndMs: finite.nullable() }).strict()
  .refine((lap) => lap.rawFrameCount > (lap.trailingContextFrameCount ?? 0), "Portable lap has no owned frames");
const identitySchema = z.object({ schemaVersion: z.literal(1), originalActivityId: z.string().min(1).nullable(), sourceRevision: z.string().min(1).nullable(), ownerUserId: z.string().min(1).nullable(),
  sourceAuthorUserId: z.string().nullable(), sourceAuthorDisplayName: z.string().nullable(), ownership: z.enum(["mine", "others"]),
  representation: z.object({ coordinates: z.literal("capture-byte-v1"), contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), kind: z.enum(["original", "partial", "downsample"]) }).strict(),
  originalSource: z.object({ coordinates: z.literal("native-record-v1"), sourceRevision: z.string().min(1), originalLapGuids: z.array(z.string().uuid()), sourceRecordCount: count,
    nativeRecordHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().nullable(),
  session: z.object({ createdAt: z.string().min(1), sessionType: z.string().nullable(), driverAttribution: attribution.nullable(), driverAttributionStints: z.array(stintSchema).nullable(),
    frameClock: z.enum(["capture_utc", "unknown"]).optional(), clockAnchor: clockAnchorSchema.nullable().optional(), duration: durationSchema.nullable().optional() }).strict(),
  laps: z.array(lapSchema),
}).strict();
interface NativeSourceSummary { sourceRecordCount: number; nativeRecordHash: string; clockAnchor: { frameTimeMs: number; utcTimeMs: number } | null }
function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function nativeSourceSummary(bytes: Buffer): NativeSourceSummary {
  const hash = createHash("sha256");
  let sourceRecordCount = 0;
  let clockAnchor: NativeSourceSummary["clockAnchor"] = null;
  for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
    updateNativeRecordDigest(hash, record);
    sourceRecordCount++;
    if (record.kind === "clock-anchor") clockAnchor = { frameTimeMs: record.frameTimeMs, utcTimeMs: record.utcTimeMs };
  }
  return { sourceRecordCount, nativeRecordHash: `sha256:${hash.digest("hex")}`, clockAnchor };
}
function writeNativeRecord(record: SessionCaptureRecord, output: Buffer, offset: number): number {
  if (record.kind === "frame") {
    const prefix = encodeFrameLength(record.frame.length, record.frameTimeMs);
    const length = prefix.length + record.frame.length;
    if (offset + length > output.length) throw new Error("Original native source exceeds its closed byte coverage");
    prefix.copy(output, offset);
    record.frame.copy(output, offset + prefix.length);
    return length;
  }
  const marker = encodeSessionMetadataRecord(record);
  if (offset + marker.length > output.length) throw new Error("Original native source exceeds its closed byte coverage");
  marker.copy(output, offset);
  return marker.length;
}

/** Losslessly rebuild all original native records, excluding synthetic per-member replay context. */
export async function loadFullOriginalPortableCapture(sessionId: number): Promise<{ bytes: Buffer; windows: Map<number, { rawByteOffset: number; rawFrameCount: number; trailingContextFrameCount?: number }> } | null> {
  const proof = await readOriginalActivitySourceProof(sessionId, { includeBorrowed: true });
  if (!proof) return null;
  const session = await readDb.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.downsampledFrequencyHz !== null) return null;
  const rows = await readDb.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
  const retained = await readClient.execute({ sql: "SELECT native_source_hash FROM original_activity_sources WHERE original_activity_id=?", args: [proof.originalActivityId] });
  const retainedHash = retained.rows[0]?.native_source_hash;
  const trailing = (row: typeof rows[number], owned?: number, knownTrailing = 0): number => {
    const value = row.sourceFrameCount === null ? knownTrailing : (row.rawFrameCount ?? 0) - row.sourceFrameCount;
    if (value !== 0 && value !== 1) throw new Error("Original lap ownership window changed");
    if (owned !== undefined && row.rawFrameCount !== owned + value) throw new Error("Original lap ownership window changed");
    return value;
  };
  if (session.captureLayoutVersion !== 1 && session.captureLayoutVersion !== 2 && session.captureLayoutVersion !== 3) {
    if (!session.rawFile || !/\.bin(?:\.gz)?$/.test(session.rawFile)) return null;
    const bytes = decompressIfGzipSync(await readFile(session.rawFile));
    // An arbitrary raw file cannot establish its own full-original digest.
    if (retainedHash !== nativeSourceSummary(bytes).nativeRecordHash) return null;
    const windows = new Map<number, { rawByteOffset: number; rawFrameCount: number; trailingContextFrameCount?: number }>();
    for (const row of rows) {
      if (row.rawByteOffset === null || row.rawFrameCount === null) return null;
      windows.set(row.id, { rawByteOffset: row.rawByteOffset, rawFrameCount: row.rawFrameCount, trailingContextFrameCount: trailing(row) });
    }
    return { bytes, windows };
  }
  const parts: SessionCapturePart[] = [];
  const base = { source: session.source, gameId: session.gameId as GameId, carId: session.carId, trackId: session.trackId, captureFormatVersion: session.captureFormatVersion };
  let sourceByteLength: number;
  let sourceRecordCount: number;
  let genuineNativeClosure = false;
  let nativeWireCoordinates = false;
  if (session.captureLayoutVersion === 3) {
    const capture = await readDb.select().from(liveCaptures).where(eq(liveCaptures.sessionId, sessionId)).get();
    if (!capture || capture.status !== "sealed" || capture.captureEpoch !== proof.sourceRevision ||
        capture.sourceDurableWatermark !== capture.sourceByteLength || capture.metadataDurableWatermark !== capture.sourceByteLength) return null;
    sourceByteLength = capture.sourceByteLength;
    sourceRecordCount = capture.sourceRecordCount;
    genuineNativeClosure = session.nativeCaptureOrigin && proof.origin === "native_capture";
    const members = await readDb.select({ descriptor: liveCaptureMembers.descriptor }).from(liveCaptureMembers)
      .where(eq(liveCaptureMembers.captureEpoch, capture.captureEpoch)).orderBy(liveCaptureMembers.generation).all();
    for (const value of members) {
      const member = Schema.decodeSync(Schema.fromJsonString(LiveArchiveMemberSchema))(value.descriptor);
      const artifact = resolveLiveLapCaptureArtifact(capture.archivePath, {
        version: 5, gameId: base.gameId, captureEpoch: capture.captureEpoch, attempt: capture.attempt,
        generation: capture.generation, committedArchiveLength: capture.committedArchiveLength,
        sourceDurableWatermark: capture.sourceDurableWatermark, metadataDurableWatermark: capture.metadataDurableWatermark,
        sourceRevision: capture.captureEpoch, sourceByteLength, sourceRecordCount, archiveFile: "capture.bin.gz", sealed: true, member,
      });
      parts.push({ capture: { ...base, rawFile: artifact.path, artifact: artifact.artifact }, chunk: artifact.chunk });
    }
  } else {
    if (!session.captureManifestFile) return null;
    const manifest = await loadCaptureManifest(session.captureManifestFile);
    if ((session.captureLayoutVersion === 1 && manifest.version !== 3) ||
        (session.captureLayoutVersion === 2 && manifest.version !== 4) || manifest.gameId !== base.gameId) return null;
    sourceByteLength = manifest.sourceByteLength;
    sourceRecordCount = manifest.sourceRecordCount;
    genuineNativeClosure = session.nativeCaptureOrigin && proof.origin === "native_capture" && manifest.version === 3 &&
      manifest.sourceCoordinates === "native-wire-v1" && manifest.sourceClosed === true &&
      manifest.originalActivityId === proof.originalActivityId && manifest.sourceRevision === proof.sourceRevision;
    nativeWireCoordinates = manifest.version === 3 && manifest.sourceCoordinates === "native-wire-v1";
    for (const chunk of manifest.chunks) {
      const capture = manifest.version === 4 && "entryName" in chunk
        ? { ...base, rawFile: join(dirname(session.captureManifestFile), manifest.archiveFile),
          artifact: { archivePath: join(dirname(session.captureManifestFile), manifest.archiveFile), entryName: chunk.entryName, manifest } }
        : { ...base, rawFile: join(dirname(session.captureManifestFile), "path" in chunk ? chunk.path : "") };
      parts.push({ capture, chunk, manifestPath: session.captureManifestFile, manifestSourceRevision: manifest.sourceRevision });
    }
  }
  if (typeof retainedHash !== "string" && !genuineNativeClosure) return null;
  const guids = [...new Set(parts.filter((part) => part.chunk.kind === "lap").map((part) => part.chunk.lapGuid))].sort();
  if (JSON.stringify(guids) !== JSON.stringify(proof.originalLapGuids)) return null;
  const header = Buffer.concat([encodeMetaFrame(), encodeSparseCaptureFormatFrame()]);
  let outputLength = header.length;
  let sourceOrdinal = 0;
  let sourceOffset = parts[0]?.chunk.sourceByteStart ?? sourceByteLength;
  const windows = new Map<number, { rawByteOffset: number; rawFrameCount: number; trailingContextFrameCount?: number }>();
  const nativeHash = createHash("sha256");
  // Size/hash pass keeps decompression streaming; allocate the complete result only once.
  for (const part of parts) {
    const chunk = part.chunk;
    if (chunk.sourceStart !== sourceOrdinal || chunk.sourceByteStart !== sourceOffset || chunk.sourceEnd - chunk.sourceStart !== chunk.recordCount) return null;
    const row = chunk.kind === "lap" ? rows.find((candidate) => String(candidate.id) === chunk.lapId && candidate.lapGuid === chunk.lapGuid) : undefined;
    let wireLength = 0;
    for await (const record of iterateOriginalCapturePartRecords(part)) {
      if (record.kind === "frame" && row && record.offset === chunk.ownedFrameByteOffset) {
        if (row.rawFrameCount === null) return null;
        windows.set(row.id, { rawByteOffset: outputLength, rawFrameCount: row.rawFrameCount,
          trailingContextFrameCount: trailing(row, chunk.ownedFrameCount, chunk.trailingContextFrameCount ?? 0) });
      }
      updateNativeRecordDigest(nativeHash, record);
      const length = record.kind === "frame" ? record.frame.length + (record.frameTimeMs === undefined ? 4 : 12)
        : encodeSessionMetadataRecord(record).length;
      wireLength += length;
      outputLength += length;
      if (!Number.isSafeInteger(outputLength) || outputLength > MAX_DECOMPRESSED_CAPTURE_BYTES) return null;
    }
    if (nativeWireCoordinates && wireLength !== chunk.sourceByteEnd - chunk.sourceByteStart) return null;
    sourceOrdinal = chunk.sourceEnd;
    sourceOffset = chunk.sourceByteEnd;
  }
  if (sourceOrdinal !== sourceRecordCount || sourceOffset !== sourceByteLength || windows.size !== rows.length) return null;
  const nativeRecordHash = `sha256:${nativeHash.digest("hex")}`;
  if (typeof retainedHash === "string" && retainedHash !== nativeRecordHash) return null;
  const output = Buffer.allocUnsafe(outputLength);
  header.copy(output);
  let offset = header.length;
  const copiedHash = createHash("sha256");
  for (const part of parts) {
    for await (const record of iterateOriginalCapturePartRecords(part)) {
      updateNativeRecordDigest(copiedHash, record);
      offset += writeNativeRecord(record, output, offset);
    }
  }
  if (offset !== output.length || `sha256:${copiedHash.digest("hex")}` !== nativeRecordHash) return null;
  await bindOriginalActivityNativeSourceHash(sessionId, nativeRecordHash);
  return { bytes: output, windows };
}

/** Exact saved identity/native attribution; no name/time matching or new IDs on export. */
export async function buildPortableCaptureIdentity(sessionId: number, bytes: Buffer,
  exportedWindows: readonly { lapId: number; rawByteOffset: number; rawFrameCount: number; trailingContextFrameCount?: number }[]): Promise<PortableCaptureIdentity> {
  const session = await readDb.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error("Original session disappeared during export");
  const rows = await readDb.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
  const reconciliation = await readDb.select({ lapId: lapGuidReconciliation.lapId, lapGuid: lapGuidReconciliation.lapGuid,
    sourceGuid: lapGuidReconciliation.sourceGuid, status: lapGuidReconciliation.status }).from(lapGuidReconciliation)
    .innerJoin(laps, eq(laps.id, lapGuidReconciliation.lapId)).where(eq(laps.sessionId, sessionId)).all();
  const reconciledById = new Map(reconciliation.map((row) => [row.lapId, row]));
  const proof = await readOriginalActivitySourceProof(sessionId, { includeBorrowed: true });
  const metadata: PortableLapIdentity[] = exportedWindows.map((window) => {
    const lap = rows.find((row) => row.id === window.lapId);
    if (!lap) throw new Error("Original lap disappeared during export");
    const resolved = reconciledById.get(lap.id);
    const lapGuidStatus = resolved?.status === "resolved" && resolved.lapGuid === lap.lapGuid
      && (resolved.sourceGuid === null || resolved.sourceGuid === lap.lapGuid) ? "resolved" : "held_ambiguous";
    return { lapGuid: lap.lapGuid, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, invalidReason: lap.invalidReason, classification: lap.classification,
      lapGuidStatus,
      rawByteOffset: window.rawByteOffset, rawFrameCount: window.rawFrameCount, sectorTimes: lap.sectorTimes, recordedAt: lap.recordedAt, createdAt: lap.createdAt,
      ...(window.trailingContextFrameCount === undefined ? {} : { trailingContextFrameCount: window.trailingContextFrameCount }),
      totalTimeMs: lap.totalTimeMs, sectorTimesMs: lap.sectorTimesMs,
      driverAttribution: lap.driverAttribution, driverAttributionStints: lap.driverAttributionStints,
      sourceClockDomain: lap.sourceClockDomain, sourceLapStartMs: lap.sourceLapStartMs, sourceLapEndMs: lap.sourceLapEndMs };
  });
  const guids = metadata.map((lap) => lap.lapGuid).sort();
  const retained = proof ? await readClient.execute({ sql: "SELECT native_source_hash FROM original_activity_sources WHERE original_activity_id=?", args: [proof.originalActivityId] }) : null;
  const nativeSource = inspectPortableWindows(bytes, metadata);
  const complete = proof !== null && retained?.rows[0]?.native_source_hash === nativeSource.nativeRecordHash
    && guids.length === proof.originalLapGuids.length && guids.every((guid, index) => guid === proof.originalLapGuids[index]);
  let duration: PortableCaptureIdentity["session"]["duration"] = null;
  if (complete) {
    if (session.verifiedOriginalDurationJson !== null) duration = durationSchema.parse(JSON.parse(session.verifiedOriginalDurationJson));
    else {
      const measured = await readClient.execute({ sql: `SELECT d.duration_status,d.elapsed_seconds,d.duration_attribution_json
        FROM dashboard_session_summaries d JOIN dashboard_summary_state st ON st.session_id=d.session_id
        WHERE d.session_id=? AND d.source_revision=st.source_revision AND st.published_revision=st.source_revision
          AND st.processor_version=? AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0`,
        args: [sessionId, DASHBOARD_PROCESSOR_VERSION] });
      const row = measured.rows[0];
      if (row && (row.duration_status === "available" || row.duration_status === "unavailable")) {
        duration = durationSchema.parse({ status: row.duration_status, elapsedSeconds: row.elapsed_seconds,
          attribution: dashboardDurationAttribution(row.duration_attribution_json) });
      }
    }
  }
  const identity: PortableCaptureIdentity = {
    schemaVersion: 1, originalActivityId: session.originalActivityId, ownerUserId: session.ownerUserId,
    sourceRevision: session.originalSourceRevision ?? proof?.sourceRevision ?? null,
    // A full relay remains the original author's source, not the exporting viewer's capture.
    sourceAuthorUserId: session.sourceAuthorUserId, sourceAuthorDisplayName: session.sourceAuthorDisplayName, ownership: complete ? "mine" : session.ownership,
    representation: { coordinates: "capture-byte-v1", contentHash: digest(bytes), kind: session.downsampledFrequencyHz !== null ? "downsample" : complete ? "original" : "partial" },
    originalSource: complete ? { coordinates: "native-record-v1", sourceRevision: proof.sourceRevision, originalLapGuids: proof.originalLapGuids,
      sourceRecordCount: nativeSource.sourceRecordCount, nativeRecordHash: nativeSource.nativeRecordHash } : null,
    session: { createdAt: session.createdAt, sessionType: session.sessionType, driverAttribution: session.driverAttribution, driverAttributionStints: session.driverAttributionStints,
      frameClock: recordedCaptureFrameClock(session), clockAnchor: nativeSource.clockAnchor ?? recordedCaptureClockAnchor(session.captureClockAnchorJson), duration },
    laps: metadata,
  };
  return validatePortableCoverage(identitySchema.parse(identity), nativeSource);
}

function inspectPortableWindows(bytes: Buffer, laps: readonly PortableLapIdentity[]): NativeSourceSummary {
  if (!containsSparseCaptureFrames(bytes)) throw new Error("Portable capture content identity mismatch");
  const windows = [...laps].sort((a, b) => a.rawByteOffset - b.rawByteOffset);
  const hash = createHash("sha256");
  let recordCount = 0;
  let nextWindow = 0;
  let ownedRemaining = 0;
  let trailingRemaining = 0;
  let clockAnchor: NativeSourceSummary["clockAnchor"] = null;
  for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
    updateNativeRecordDigest(hash, record);
    recordCount++;
    if (record.kind === "clock-anchor") clockAnchor = { frameTimeMs: record.frameTimeMs, utcTimeMs: record.utcTimeMs };
    const next = windows[nextWindow];
    if (next && next.rawByteOffset < record.offset) throw new Error("Portable lap frame window is missing");
    if (record.kind !== "frame") {
      if (ownedRemaining > 0 || trailingRemaining > 0) throw new Error("Portable lap crosses a source boundary");
      continue;
    }
    if (ownedRemaining === 0 && trailingRemaining > 0) trailingRemaining--;
    if (next?.rawByteOffset === record.offset) {
      if (ownedRemaining > 0) throw new Error("Portable lap frame windows overlap");
      trailingRemaining = next.trailingContextFrameCount ?? 0;
      if (trailingRemaining !== 0 && trailingRemaining !== 1) throw new Error("Invalid portable completion context");
      ownedRemaining = next.rawFrameCount - trailingRemaining;
      if (ownedRemaining <= 0) throw new Error("Portable lap has no owned frames");
      nextWindow++;
    }
    if (ownedRemaining > 0) ownedRemaining--;
  }
  if (ownedRemaining > 0 || trailingRemaining > 0 || nextWindow !== windows.length) throw new Error("Portable lap frame window is truncated or missing");
  const nativeRecordHash = `sha256:${hash.digest("hex")}`;
  return { sourceRecordCount: recordCount, nativeRecordHash, clockAnchor };
}

function validatePortableCoverage(identity: PortableCaptureIdentity, nativeSource: NativeSourceSummary): PortableCaptureIdentity {
  const savedAnchor = identity.session.clockAnchor;
  if (nativeSource.clockAnchor) {
    if (savedAnchor && (savedAnchor.frameTimeMs !== nativeSource.clockAnchor.frameTimeMs || savedAnchor.utcTimeMs !== nativeSource.clockAnchor.utcTimeMs)) {
      throw new Error("Portable clock anchor conflicts with captured source metadata");
    }
    identity.session.clockAnchor = nativeSource.clockAnchor;
  }
  if (identity.session.frameClock === "capture_utc" && identity.session.clockAnchor
    && identity.session.clockAnchor.frameTimeMs !== identity.session.clockAnchor.utcTimeMs) throw new Error("Portable UTC frame-clock mapping conflicts with its source anchor");
  const guids = new Set<string>();
  for (const lap of identity.laps) {
    if (lap.lapGuid !== null && (lap.lapGuid !== lap.lapGuid.toLowerCase() || guids.has(lap.lapGuid))) throw new Error("Duplicate or noncanonical portable lap GUID");
    if (lap.lapGuid) guids.add(lap.lapGuid);
    if (lap.sourceLapStartMs !== null && lap.sourceLapEndMs !== null && lap.sourceLapEndMs < lap.sourceLapStartMs) throw new Error("Portable native lap interval is invalid");
  }
  if (identity.representation.kind === "original") {
    const source = identity.originalSource;
    if (!identity.originalActivityId || identity.ownership !== "mine" || !source || source.sourceRecordCount !== nativeSource.sourceRecordCount
      || source.nativeRecordHash !== nativeSource.nativeRecordHash
      || identity.sourceRevision !== source.sourceRevision
      || guids.size !== identity.laps.length || source.originalLapGuids.length !== guids.size
      || identity.laps.some((lap) => lap.lapGuidStatus !== "resolved")
      || new Set(source.originalLapGuids).size !== guids.size || source.originalLapGuids.some((guid) => !guids.has(guid))) throw new Error("Portable original source membership is incomplete");
  } else {
    if (identity.originalSource !== null) throw new Error("Transformed portable capture cannot claim complete original coverage");
    if (identity.laps.length === 0) throw new Error("Empty portable capture requires complete original source proof");
    if (identity.session.duration != null) throw new Error("Partial portable capture cannot replace original duration facts");
  }
  return identity;
}

export function validatePortableCaptureIdentity(bytes: Buffer, input: unknown): PortableCaptureIdentity {
  const identity = identitySchema.parse(input);
  if (digest(bytes) !== identity.representation.contentHash) throw new Error("Portable capture content identity mismatch");
  return validatePortableCoverage(identity, inspectPortableWindows(bytes, identity.laps));
}

async function insertPortableLap(tx: Transaction, sessionId: number, lap: PortableLapIdentity, identity: PortableCaptureIdentity): Promise<number> {
  const inserted = await tx.execute({ sql: `INSERT INTO laps(session_id,lap_number,lap_time,is_valid,invalid_reason,raw_byte_offset,raw_frame_count,source_frame_count,sector_times,recorded_at,created_at,driver_attribution,driver_attribution_stints,source_clock_domain,source_lap_start_ms,source_lap_end_ms,total_time_ms,sector_times_ms,classification)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, args: [sessionId, lap.lapNumber, lap.lapTime, lap.isValid ? 1 : 0, lap.invalidReason, lap.rawByteOffset, lap.rawFrameCount,
      lap.rawFrameCount - (lap.trailingContextFrameCount ?? 0), lap.sectorTimes === null ? null : JSON.stringify(lap.sectorTimes), lap.recordedAt, lap.createdAt, lap.driverAttribution, lap.driverAttributionStints === null ? null : JSON.stringify(lap.driverAttributionStints), lap.sourceClockDomain, lap.sourceLapStartMs, lap.sourceLapEndMs,
      lap.totalTimeMs, lap.sectorTimesMs === null ? null : JSON.stringify(lap.sectorTimesMs), lap.classification ?? null] });
  const lapId = Number(inserted.rows[0]!.id);
  if (lap.lapGuid && lap.lapGuidStatus === "resolved") {
    await bindAuthoritativeLapGuidInTransaction(tx, lapId, lap.lapGuid);
  } else {
    await tx.execute({ sql: "UPDATE laps SET lap_guid=? WHERE id=?", args: [lap.lapGuid, lapId] });
    await tx.execute({ sql: "INSERT INTO lap_guid_reconciliation(lap_id,lap_guid,status) VALUES(?,?,'held_ambiguous')", args: [lapId, lap.lapGuid] });
  }
  if (lap.lapGuid) await retainOriginalLapIdentityInTransaction(tx, lap.lapGuid, identity.originalActivityId, identity.ownerUserId, identity.sourceRevision);
  return lapId;
}

async function preservePortableSourceFacts(tx: Transaction, sessionId: number, identity: PortableCaptureIdentity): Promise<void> {
  const duration = identity.representation.kind === "original" && identity.originalSource ? identity.session.duration : null;
  const prior = (await tx.execute({ sql: "SELECT native_capture_origin,capture_format_version,capture_frame_clock,capture_clock_anchor_json FROM sessions WHERE id=?", args: [sessionId] })).rows[0];
  const priorAnchor = recordedCaptureClockAnchor(prior?.capture_clock_anchor_json);
  const incomingAnchor = identity.session.clockAnchor;
  const utcClock = prior?.capture_frame_clock === "capture_utc" || (prior?.native_capture_origin === 1 && prior.capture_format_version === 1)
    || identity.session.frameClock === "capture_utc";
  if (incomingAnchor && ((priorAnchor && priorAnchor.utcTimeMs - priorAnchor.frameTimeMs !== incomingAnchor.utcTimeMs - incomingAnchor.frameTimeMs)
    || (utcClock && incomingAnchor.utcTimeMs !== incomingAnchor.frameTimeMs))) throw new Error("Portable clock mapping conflicts with retained original source");
  if (utcClock && priorAnchor && priorAnchor.utcTimeMs !== priorAnchor.frameTimeMs) throw new Error("Portable UTC frame clock conflicts with retained source anchor");
  await tx.execute({ sql: `UPDATE sessions SET capture_frame_clock=COALESCE(?,capture_frame_clock),
    capture_clock_anchor_json=COALESCE(capture_clock_anchor_json,?),
    verified_original_duration_json=COALESCE(?,verified_original_duration_json) WHERE id=?`,
    args: [identity.session.frameClock === "capture_utc" ? "capture_utc" : null,
      identity.session.clockAnchor == null ? null : JSON.stringify(identity.session.clockAnchor), duration == null ? null : JSON.stringify(duration), sessionId] });
}

interface RegisteredPortableCapture { packetCount: number; laps: ImportedLap[]; sessionIds: readonly number[] }

/** Register preserved rows directly: no detector or timing recomputation, all identity writes atomic. */
export async function importPortableCapture(bytesInput: Buffer, input: unknown, context: { gameId: GameId; carId: string; trackId: string; ownership?: "mine" | "others" }): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  const result = await withSessionCaptureMaintenanceLock(() => registerPortableCapture(bytesInput, input, context));
  // Splitting acquires the same maintenance lock; publish only after registration releases it.
  for (const sessionId of result.sessionIds) await enqueueSessionCaptureSplit(sessionId);
  notifyOnlineSync();
  return { packetCount: result.packetCount, laps: result.laps };
}

async function registerPortableCapture(bytesInput: Buffer, input: unknown, context: { gameId: GameId; carId: string; trackId: string; ownership?: "mine" | "others" }): Promise<RegisteredPortableCapture> {
  const bytes = decompressIfGzipSync(bytesInput);
  const identity = validatePortableCaptureIdentity(bytes, input);
  const detectedGame = detectGameIdFromBuffer(bytes);
  if (detectedGame !== context.gameId) {
    // A genuinely empty source has no native packet from which to infer a game.
    // Keep its declared container context; never manufacture a lap or source identity.
    if (identity.laps.length !== 0 || detectedGame !== null) throw new Error("Portable capture game identity cannot be verified");
    for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
      if (record.kind === "frame") throw new Error("Portable capture game identity cannot be verified");
    }
  }
  const directory = resolveRecordingGameDirectory(context.gameId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `portable-${randomUUID()}.bin`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  let used = false;
  let committed = false;
  const register = async (tx: Transaction): Promise<RegisteredPortableCapture> => {
    const local = await tx.execute("SELECT online_user_id FROM local_account_owner WHERE id=1");
    const localOwner = local.rows[0]?.online_user_id ?? null;
    const retained = identity.originalActivityId
      ? await tx.execute({ sql: "SELECT owner_user_id,claimable,source_revision FROM original_activity_sources WHERE original_activity_id=?", args: [identity.originalActivityId] })
      : null;
    if (retained?.rows[0] && retained.rows[0].owner_user_id !== identity.ownerUserId) throw new Error("Portable original owner conflicts with retained history");
    if (retained?.rows[0] && identity.sourceRevision !== null && retained.rows[0].source_revision !== identity.sourceRevision) throw new Error("Portable original revision conflicts with retained history");
    const unassignedOwnedOriginal = identity.ownerUserId === null && retained?.rows[0]?.claimable === 1;
    const foreignOwner = localOwner !== null && identity.ownerUserId !== null && localOwner !== identity.ownerUserId;
    const ownership = identity.ownership === "others" || context.ownership === "others" || foreignOwner
      || (identity.ownerUserId === null && !unassignedOwnedOriginal) ? "others" : "mine";
    const result: ImportedLap[] = [];
    const existing = [];
    for (const lap of identity.laps) {
      if (!lap.lapGuid) continue;
      const known = await tx.execute({ sql: "SELECT original_activity_id,owner_user_id,source_revision FROM original_activity_source_laps WHERE lap_guid=?", args: [lap.lapGuid] });
      if (known.rows[0] && ((known.rows[0].original_activity_id !== null && known.rows[0].original_activity_id !== identity.originalActivityId) || known.rows[0].owner_user_id !== identity.ownerUserId)) {
        throw new Error("Portable lap identity conflicts with retained original ownership");
      }
      if (known.rows[0]?.source_revision != null && identity.sourceRevision !== null && known.rows[0].source_revision !== identity.sourceRevision) throw new Error("Portable original revision conflicts with retained lap identity");
      const matches = await tx.execute({ sql: `SELECT l.id,l.session_id,l.classification,s.owner_user_id,s.original_activity_id,s.original_source_revision,s.game_id,s.car_id,s.track_id,s.raw_file,s.ownership
        FROM laps l JOIN sessions s ON s.id=l.session_id WHERE l.lap_guid=?`, args: [lap.lapGuid] });
      for (const row of matches.rows) {
        if (row.owner_user_id !== identity.ownerUserId || row.original_activity_id !== identity.originalActivityId || row.game_id !== context.gameId || row.car_id !== context.carId || row.track_id !== context.trackId) throw new Error("Portable original identity conflicts with local ownership or source");
        if (row.original_source_revision !== null && identity.sourceRevision !== null && row.original_source_revision !== identity.sourceRevision) throw new Error("Portable original revision conflicts with local source");
        existing.push({ row, lap });
      }
    }
    let emptySessionId: number | null = null;
    if (identity.laps.length === 0) {
      const empty = await tx.execute({ sql: `SELECT s.id,s.game_id,s.car_id,s.track_id,
          (SELECT COUNT(*) FROM laps l WHERE l.session_id=s.id) AS lap_count
        FROM sessions s WHERE s.original_activity_id=? AND s.original_source_revision=? AND s.owner_user_id IS ?
          AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL ORDER BY s.id`,
        args: [identity.originalActivityId, identity.sourceRevision, identity.ownerUserId] });
      if (empty.rows.length > 1) throw new Error("Portable empty original overlaps multiple local representations");
      const prior = empty.rows[0];
      if (prior) {
        if (Number(prior.lap_count) !== 0 || prior.game_id !== context.gameId || prior.car_id !== context.carId || prior.track_id !== context.trackId) {
          throw new Error("Portable empty original conflicts with retained source context or membership");
        }
        emptySessionId = Number(prior.id);
      }
    }
    if (existing.length > 0 || emptySessionId !== null) {
      if (existing.length > 0 && new Set(existing.map(({ row }) => Number(row.session_id))).size !== 1) throw new Error("Portable import overlaps multiple local originals");
      const sessionId = emptySessionId ?? Number(existing[0]!.row.session_id);
      const full = identity.representation.kind === "original" && identity.originalSource !== null && identity.originalActivityId !== null;
      if (existing.length !== identity.laps.length && !full) throw new Error("Partial portable import overlaps incomplete local membership");
      const current = await tx.execute({ sql: `SELECT l.id,l.lap_guid,r.status FROM laps l
        LEFT JOIN lap_guid_reconciliation r ON r.lap_id=l.id WHERE l.session_id=?`, args: [sessionId] });
      const fullGuids = new Set(identity.originalSource?.originalLapGuids ?? []);
      if (full && (new Set(current.rows.map((row) => row.lap_guid)).size !== current.rows.length
        || current.rows.some((row) => typeof row.lap_guid !== "string" || !fullGuids.has(row.lap_guid) || row.status !== "resolved"))) {
        throw new Error("Portable original overlaps unresolved or resegmented local membership");
      }
      const knownLaps = new Map(existing.map(({ row, lap }) => [lap.lapGuid, row]));
      for (const lap of identity.laps) {
        const known = knownLaps.get(lap.lapGuid);
        const lapId = known ? Number(known.id) : await insertPortableLap(tx, sessionId, lap, identity);
        const classification = known ? lapClassificationSchema.parse(known.classification) : lap.classification ?? null;
        result.push({ lapId, sessionId, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, classification, carId: context.carId, trackId: context.trackId });
      }
      if (identity.representation.kind === "original" && identity.originalSource && identity.originalActivityId) {
        // Restore source bytes, but never repair ambiguous lap identity or reassign ownership.
        await registerVerifiedPortableOriginalInTransaction(tx, sessionId, {
          schemaVersion: 1, originalActivityId: identity.originalActivityId, sourceRevision: identity.originalSource.sourceRevision,
          originalLapGuids: identity.originalSource.originalLapGuids, ownerUserId: identity.ownerUserId, coverage: "complete", origin: "verified_portable",
        }, identity.originalSource.nativeRecordHash);
        await tx.execute({ sql: `UPDATE sessions SET raw_file=?,capture_layout_version=NULL,capture_manifest_file=NULL,capture_archive_file=NULL,
          downsampled_frequency_hz=NULL,capture_format_version=1 WHERE id=?`, args: [path, sessionId] });
        for (const [index, imported] of result.entries()) {
          const metadata = identity.laps[index]!;
          await tx.execute({ sql: "UPDATE laps SET raw_byte_offset=?,raw_frame_count=?,capture_chunk_id=NULL,source_frame_start=NULL,source_frame_count=? WHERE id=?",
            args: [metadata.rawByteOffset, metadata.rawFrameCount, metadata.rawFrameCount - (metadata.trailingContextFrameCount ?? 0), imported.lapId] });
        }
        used = true;
      }
      await preservePortableSourceFacts(tx, sessionId, identity);
      return { packetCount: 0, laps: result, sessionIds: [sessionId] };
    }
    const inserted = await tx.execute({ sql: `INSERT INTO sessions(car_id,track_id,game_id,session_type,raw_file,capture_format_version,ownership,owner_user_id,original_activity_id,native_capture_origin,source_author_user_id,source_author_display_name,driver_attribution,driver_attribution_stints,created_at,original_source_revision)
      VALUES(?,?,?,?,?,1,?,?,?,0,?,?,?,?,?,?) RETURNING id`, args: [context.carId, context.trackId, context.gameId, identity.session.sessionType, path, ownership, identity.ownerUserId, identity.originalActivityId,
        identity.sourceAuthorUserId, identity.sourceAuthorDisplayName, identity.session.driverAttribution, identity.session.driverAttributionStints === null ? null : JSON.stringify(identity.session.driverAttributionStints), identity.session.createdAt, identity.sourceRevision] });
    const sessionId = Number(inserted.rows[0]!.id);
    for (const lap of identity.laps) {
      const lapId = await insertPortableLap(tx, sessionId, lap, identity);
      result.push({ lapId, sessionId, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, classification: lap.classification ?? null, carId: context.carId, trackId: context.trackId });
    }
    if (identity.representation.kind === "original" && identity.originalSource && identity.originalActivityId) {
      await registerVerifiedPortableOriginalInTransaction(tx, sessionId, { schemaVersion: 1, originalActivityId: identity.originalActivityId, sourceRevision: identity.originalSource.sourceRevision,
        originalLapGuids: identity.originalSource.originalLapGuids, ownerUserId: identity.ownerUserId, coverage: "complete", origin: "verified_portable" }, identity.originalSource.nativeRecordHash);
    }
    await preservePortableSourceFacts(tx, sessionId, identity);
    used = true;
    return { packetCount: identity.laps.reduce((sum, lap) => sum + lap.rawFrameCount, 0), laps: result, sessionIds: [sessionId] };
  };
  try {
    const registered = await withDatabaseTransaction(client, register);
    committed = true;
    if (used) {
      for (const sessionId of registered.sessionIds) {
        await markDashboardCaptureCheckpoint(sessionId, true);
        await processDashboardSession(sessionId);
      }
      notifyOnlineSync();
    }
    return registered;
  } finally {
    if (!committed || !used) {
      // Commit may succeed before transaction cleanup reports a failure.
      const retained = await readDb.select({ id: sessions.id }).from(sessions).where(eq(sessions.rawFile, path)).get();
      if (!retained) await rm(path, { force: true });
    }
  }
}
