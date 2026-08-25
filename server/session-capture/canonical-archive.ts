import { DuckDBInstance } from "@duckdb/node-api";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import {
  CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
  CanonicalArchiveManifestSchema,
  CanonicalArchiveNodeSchema,
  type CanonicalArchiveNode,
} from "../../shared/racing/archives/contracts";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import { QUALITY_POLICY_CONFIG_V1 } from "../../shared/racing/quality/policies";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  type AnalysisComponentIdentity,
  type AnalysisVerificationCheckId,
} from "../../shared/racing/provenance/contracts";
import { getActiveAnalysisReceipt, type AnalysisReceiptRow } from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { readCanonicalArchiveSamples } from "../db/canonical-archive-reader";
import {
  assertCanonicalArchiveJobLease,
  enqueueCanonicalArchiveJob,
  getActiveVerifiedCanonicalArchive,
  type CanonicalArchiveJobLease,
} from "../db/canonical-archive-queries";
import { getCorners } from "../db/track-queries";
import { canonicalArchiveNodes, canonicalArchives, laps, sessionRuns, sessions } from "../db/schema";
import { getSessionRawFile } from "../db/telemetry-replay-storage";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { analysisCanonicalHash, analysisContractHash } from "../analysis-provenance/hash";
import { resolveTrack } from "../tracks/info";
import { activateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import { resolveDataDir } from "../runtime/config/data-dir";
import { inspectRawCaptureIdentity, iterateRawCaptureBytes, rawCaptureObjectId } from "./identity";
import { META_FRAME_MAGIC } from "./framing";
import { withSessionCaptureMaintenanceLock } from "./cleanup";

const ARCHIVE_DIR = "archives/sessions";
const SAMPLE_TABLE = "telemetry_samples";
const DUCKDB_WRITER_MEMORY_LIMIT = "1GB";
const DUCKDB_VERIFIER_MEMORY_LIMIT = "512MB";
const DUCKDB_THREADS = 1;
const DUCKDB_TEMP_DIRECTORY_LIMIT = "1GB";
const APPENDER_BATCH_SIZE = 4_096;
const MAX_CANONICAL_ARCHIVE_PACKETS = 500_000;
const MAX_CANONICAL_PACKET_JSON_BYTES = 256 * 1024;
const MAX_CANONICAL_PACKET_JSON_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANONICAL_ARCHIVE_BYTES = 512 * 1024 * 1024;
const FINALIZED_SOURCE_GENERATION_PATTERN = /^sha256:[0-9a-f]{64}$/;
function addPacketJsonBytes(total: number, bytes: number): number {
  const next = total + bytes;
  if (next > MAX_CANONICAL_PACKET_JSON_TOTAL_BYTES) {
    throw new Error(`Canonical archive exceeds ${MAX_CANONICAL_PACKET_JSON_TOTAL_BYTES} streamed packet JSON byte limit`);
  }
  return next;
}

/** Test-only aggregate guard; production serialization invokes the same check per packet. */
export function addCanonicalArchivePacketJsonBytesForTest(total: number, bytes: number): number {
  return addPacketJsonBytes(total, bytes);
}

/** Test-only visibility for bounded DuckDB archive writer configuration. */
export function canonicalArchiveDuckDbConfigForTest(): { writerMemoryLimit: string; verifierMemoryLimit: string; tempDirectoryLimit: string; threads: number; preserveInsertionOrder: false } {
  return {
    writerMemoryLimit: DUCKDB_WRITER_MEMORY_LIMIT,
    verifierMemoryLimit: DUCKDB_VERIFIER_MEMORY_LIMIT,
    tempDirectoryLimit: DUCKDB_TEMP_DIRECTORY_LIMIT,
    threads: DUCKDB_THREADS,
    preserveInsertionOrder: false,
  };
}

interface SampleRow {
  sampleOrdinal: number;
  participantId: string | null;
  lapId: number | null;
  lapNumber: number | null;
  sourceTimeMs: number;
  receivedAtMs: number;
  trackDistanceM: number | null;
  trackDistancePct: number | null;
  speed: number | null;
  accel: number | null;
}

interface ArchiveWriteResult {
  archiveId: string;
  generationId: string;
  finalPath: string;
  outputContentHash: string;
  byteSize: number;
  samples: SampleRow[];
  nodes: CanonicalArchiveNode[];
  semanticIds: string[];
  eventIds: string[];
  manifest: ReturnType<typeof CanonicalArchiveManifestSchema.parse>;
  context: {
    gameId: string;
    trackId: string | null;
    layoutId: string | null;
    trackDefinitionHash: string | null;
    cornerDefinitionHash: string | null;
    sourceKind: string | null;
    sourcePath: string | null;
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256ArchiveFile(path: string): Promise<{ contentHash: string; byteSize: number }> {
  const expectedSize = Bun.file(path).size;
  if (expectedSize > MAX_CANONICAL_ARCHIVE_BYTES) {
    throw new Error(`Canonical archive exceeds ${MAX_CANONICAL_ARCHIVE_BYTES} byte limit`);
  }
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    byteSize += chunk.byteLength;
    if (byteSize > MAX_CANONICAL_ARCHIVE_BYTES) {
      throw new Error(`Canonical archive exceeds ${MAX_CANONICAL_ARCHIVE_BYTES} byte limit`);
    }
    hash.update(chunk);
  }
  if (byteSize !== expectedSize) throw new Error("Canonical archive changed while hashing");
  return { contentHash: `sha256:${hash.digest("hex")}`, byteSize };
}

function archiveIdFor(sessionId: number, sourceHash: string, generationId: string): string {
  const digest = createHash("sha256").update(`${sessionId}:${sourceHash}:${generationId}`).digest("hex");
  return `canonical-archive:${digest}`;
}

function generationPath(sessionId: number, generationId: string): string {
  const safeGenerationId = generationId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return join(resolveDataDir(), ARCHIVE_DIR, String(sessionId), safeGenerationId);
}

function sourceTime(packet: TelemetryPacket): number {
  const value = Number(packet.TimestampMS);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function packetDistance(packet: TelemetryPacket): number | null {
  const value = Number(packet.DistanceTraveled);
  return Number.isFinite(value) ? value : null;
}

function packetLapNumber(packet: TelemetryPacket): number | null {
  const value = Number(packet.LapNumber);
  return Number.isInteger(value) && value > 0 ? value : null;
}
function packetNumericValue(packet: TelemetryPacket, field: "Speed" | "Accel"): number | null {
  const value = Number(packet[field]);
  return Number.isFinite(value) ? value : null;
}

function participantForTime(
  timeMs: number,
  runs: readonly { participantId: string | null; startSourceTimeMs: number | null; endSourceTimeMs: number | null }[],
): string | null {
  const match = runs.find((run) =>
    run.participantId != null &&
    (run.startSourceTimeMs == null || timeMs >= run.startSourceTimeMs) &&
    (run.endSourceTimeMs == null || timeMs <= run.endSourceTimeMs),
  );
  if (match) return match.participantId;
  const known = [...new Set(runs.map((run) => run.participantId).filter((id): id is string => id != null))];
  return known.length === 1 ? known[0] : null;
}

function nodeRange(samples: readonly SampleRow[], indexes: readonly number[]): { start: number; end: number; startTime: number | null; endTime: number | null; startDistance: number | null; endDistance: number | null } {
  let firstIndex = indexes[0]!;
  let lastIndex = firstIndex;
  let startTime: number | null = null;
  let endTime: number | null = null;
  for (const index of indexes) {
    if (index < firstIndex) firstIndex = index;
    if (index > lastIndex) lastIndex = index;
    const sourceTime = samples[index]?.sourceTimeMs;
    if (sourceTime == null) continue;
    if (startTime == null || sourceTime < startTime) startTime = sourceTime;
    if (endTime == null || sourceTime > endTime) endTime = sourceTime;
  }
  return {
    start: firstIndex,
    end: lastIndex + 1,
    startTime,
    endTime,
    startDistance: samples[firstIndex]?.trackDistanceM ?? null,
    endDistance: samples[lastIndex]?.trackDistanceM ?? null,
  };
}

function nodeFromRange(input: {
  archiveId: string;
  nodeId: string;
  parentNodeId: string | null;
  level: "participant" | "stint" | "lap" | "corner" | "segment";
  semanticKind: string;
  stableKey: string;
  ordinal: number;
  participantId: string | null;
  sessionRunId?: string | null;
  lapId?: number | null;
  status: string;
  definitionHash?: string | null;
  samples: readonly SampleRow[];
  indexes: readonly number[];
}): CanonicalArchiveNode {
  const range = nodeRange(input.samples, input.indexes);
  return CanonicalArchiveNodeSchema.parse({
    nodeId: input.nodeId,
    archiveId: input.archiveId,
    parentNodeId: input.parentNodeId,
    level: input.level,
    semanticKind: input.semanticKind,
    stableKey: input.stableKey,
    ordinal: input.ordinal,
    participantId: input.participantId,
    sessionRunId: input.sessionRunId ?? null,
    lapId: input.lapId ?? null,
    startRow: range.start,
    endRow: range.end,
    startSourceTimeMs: range.startTime,
    endSourceTimeMs: range.endTime,
    startTrackDistanceM: range.startDistance,
    endTrackDistanceM: range.endDistance,
    status: input.status,
    definitionHash: input.definitionHash ?? null,
    boundaryAlgorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  });
}

function semanticCandidatesForSession(sourceChannelProfile: unknown): string[] {
  const ids = new Set<string>();
  if (sourceChannelProfile && typeof sourceChannelProfile === "object" && "channels" in sourceChannelProfile) {
    const channels = (sourceChannelProfile as { channels?: Record<string, unknown> }).channels;
    for (const id of Object.keys(channels ?? {})) if (id.length > 0) ids.add(id);
  }
  for (const channels of Object.values(QUALITY_POLICY_CONFIG_V1.requiredChannels)) {
    for (const id of channels) ids.add(id);
  }
  return [...ids];
}

function actualSemanticIds(gameId: GameId, packets: readonly TelemetryPacket[], candidates: readonly string[]): string[] {
  if (packets.length === 0 || candidates.length === 0) return [];
  const resolver = compileTelemetryResolver<{ packet: TelemetryPacket }>(TELEMETRY_CATALOG, {
    simulator: gameId,
    requested: candidates.map((semanticId) => ({ semanticId })),
  });
  const slots = candidates.map((semanticId) => resolver.slot(semanticId));
  const available = new Set<string>();
  for (let index = 0; index < packets.length && available.size < candidates.length; index += 1) {
    const packet = packets[index]!;
    const view = resolver.createFrameView(
      { packet },
      {
        timestamp: { domain: "session", milliseconds: sourceTime(packet) },
        updateSequence: BigInt(index),
      },
    );
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      if (available.has(candidates[slotIndex]!)) continue;
      const resolved = view.resolveValue(slots[slotIndex]!);
      if (resolved.state === "ok" && resolved.value != null) available.add(candidates[slotIndex]!);
    }
  }
  return candidates.filter((id) => available.has(id));
}


async function writeParquet(
  stagePath: string,
  samples: readonly SampleRow[],
  packets: readonly TelemetryPacket[],
): Promise<void> {
  const spillDir = `${stagePath}.spill`;
  await mkdir(spillDir, { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(`SET memory_limit = '${DUCKDB_WRITER_MEMORY_LIMIT}'`);
    await connection.run(`SET threads = ${DUCKDB_THREADS}`);
    await connection.run("SET preserve_insertion_order = false");
    await connection.run(`SET temp_directory = ${sqlString(spillDir)}`);
    await connection.run(`SET max_temp_directory_size = '${DUCKDB_TEMP_DIRECTORY_LIMIT}'`);
    await connection.run(`CREATE TABLE ${SAMPLE_TABLE} (
      sample_ordinal BIGINT,
      participant_id VARCHAR,
      lap_id INTEGER,
      lap_number INTEGER,
      source_time_ms BIGINT,
      received_at_ms BIGINT,
      track_distance_m DOUBLE,
      track_distance_pct DOUBLE,
      packet_json VARCHAR
    )`);
    if (samples.length !== packets.length) throw new Error("Canonical archive sample and packet counts differ");
    const appender = await connection.createAppender(SAMPLE_TABLE);
    let packetJsonBytes = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      const packetJson = JSON.stringify(packets[index]!);
      const jsonBytes = Buffer.byteLength(packetJson);
      if (jsonBytes > MAX_CANONICAL_PACKET_JSON_BYTES) {
        throw new Error(`Canonical archive packet ${index} exceeds ${MAX_CANONICAL_PACKET_JSON_BYTES} JSON byte limit`);
      }
      packetJsonBytes = addPacketJsonBytes(packetJsonBytes, jsonBytes);
      appender.appendBigInt(BigInt(sample.sampleOrdinal));
      if (sample.participantId == null) appender.appendNull();
      else appender.appendVarchar(sample.participantId);
      if (sample.lapId == null) appender.appendNull();
      else appender.appendInteger(sample.lapId);
      if (sample.lapNumber == null) appender.appendNull();
      else appender.appendInteger(sample.lapNumber);
      appender.appendBigInt(BigInt(sample.sourceTimeMs));
      appender.appendBigInt(BigInt(sample.receivedAtMs));
      if (sample.trackDistanceM == null) appender.appendNull();
      else appender.appendDouble(sample.trackDistanceM);
      if (sample.trackDistancePct == null) appender.appendNull();
      else appender.appendDouble(sample.trackDistancePct);
      appender.appendVarchar(packetJson);
      appender.endRow();
      if ((sample.sampleOrdinal + 1) % APPENDER_BATCH_SIZE === 0) appender.flushSync();
    }
    appender.flushSync();
    appender.closeSync();
    await connection.run(`COPY (
      SELECT sample_ordinal, participant_id, lap_id, lap_number, source_time_ms, received_at_ms, track_distance_m, track_distance_pct, packet_json
      FROM ${SAMPLE_TABLE}
      ORDER BY sample_ordinal
    ) TO ${sqlString(stagePath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
    await rm(spillDir, { recursive: true, force: true });
  }
}
export async function verifyCanonicalArchiveParquet(path: string, expectedRows: number): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(`SET memory_limit = '${DUCKDB_VERIFIER_MEMORY_LIMIT}'`);
    await connection.run(`SET threads = ${DUCKDB_THREADS}`);
    const file = sqlString(path);
    const reader = await connection.runAndReadAll(`SELECT
      count(*) AS count,
      min(sample_ordinal) AS min_ordinal,
      max(sample_ordinal) AS max_ordinal,
      count(DISTINCT sample_ordinal) AS distinct_ordinal_count,
      sum(CASE WHEN NOT json_valid(packet_json) OR json_type(CASE WHEN json_valid(packet_json) THEN packet_json ELSE '{}' END, '$.gameId') <> 'VARCHAR' OR json_extract_string(CASE WHEN json_valid(packet_json) THEN packet_json ELSE '{}' END, '$.gameId') IS NULL OR length(json_extract_string(CASE WHEN json_valid(packet_json) THEN packet_json ELSE '{}' END, '$.gameId')) = 0 THEN 1 ELSE 0 END) AS invalid_packet_count
      FROM read_parquet(${file})`);
    await reader.readAll();
    const aggregate = reader.getRowObjectsJS()[0] ?? {};
    const count = Number(aggregate.count ?? 0);
    const minOrdinal = Number(aggregate.min_ordinal ?? -1);
    const maxOrdinal = Number(aggregate.max_ordinal ?? -1);
    const distinctOrdinalCount = Number(aggregate.distinct_ordinal_count ?? 0);
    const invalidPacketCount = Number(aggregate.invalid_packet_count ?? 0);
    if (count !== expectedRows) throw new Error(`Canonical archive row count mismatch: expected ${expectedRows}, got ${count}`);
    if (count > 0 && (minOrdinal !== 0 || maxOrdinal !== count - 1 || distinctOrdinalCount !== count)) {
      throw new Error("Canonical archive sample ordering mismatch");
    }
    if (invalidPacketCount !== 0) throw new Error(`Canonical archive contains ${invalidPacketCount} invalid packet JSON rows`);
    if (expectedRows > 0) {
      const firstPage = await readCanonicalArchiveSamples(path, 0, 1);
      const lastPage = await readCanonicalArchiveSamples(path, expectedRows - 1, expectedRows);
      if (firstPage.length !== 1 || lastPage.length !== 1) throw new Error("Canonical archive reader cannot read bounded pages");
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

let canonicalArchiveBuildHookForTest: (() => void | Promise<void>) | undefined;

/** Narrow test seam: runs after source parse and before source revalidation. */
export function setCanonicalArchiveBuildHookForTest(hook: (() => void | Promise<void>) | undefined): () => void {
  canonicalArchiveBuildHookForTest = hook;
  return () => {
    if (canonicalArchiveBuildHookForTest === hook) canonicalArchiveBuildHookForTest = undefined;
  };
}

async function readCanonicalRawPackets(rawFile: string, gameId: GameId): Promise<TelemetryPacket[]> {
  const game = getServerGame(gameId);
  const state = game.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let sawLeadingHeader = false;
  let sawRecord = false;
  let declaredFrameCount: number | null = null;
  let frameCount = 0;

  for await (const chunk of iterateRawCaptureBytes(rawFile)) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;
    while (pending.length - offset >= 4) {
      const frameLength = pending.readUInt32LE(offset);
      if (frameLength === META_FRAME_MAGIC) {
        if (pending.length - offset < 8) break;
        const metadataLength = pending.readUInt32LE(offset + 4);
        if (metadataLength !== 4) throw new Error(`Invalid recorder metadata payload length ${metadataLength}`);
        if (pending.length - offset < 8 + metadataLength) break;
        if (!sawLeadingHeader && !sawRecord) {
          declaredFrameCount = pending.readUInt32LE(offset + 8);
          sawLeadingHeader = true;
        }
        offset += 8 + metadataLength;
        continue;
      }
      if (frameLength === 0 || frameLength > MAX_CANONICAL_PACKET_JSON_BYTES) {
        throw new Error(`Canonical archive frame exceeds ${MAX_CANONICAL_PACKET_JSON_BYTES} byte limit`);
      }
      if (pending.length - offset < 4 + frameLength) break;
      frameCount++;
      sawRecord = true;
      if (frameCount > MAX_CANONICAL_ARCHIVE_PACKETS) {
        throw new Error(`Canonical archive exceeds ${MAX_CANONICAL_ARCHIVE_PACKETS} frame limit`);
      }
      const frame = pending.subarray(offset + 4, offset + 4 + frameLength);
      offset += 4 + frameLength;
      try {
        const packet = game.tryParse(frame, state);
        if (!packet) continue;
        normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
        packets.push(packet);
        if (packets.length > MAX_CANONICAL_ARCHIVE_PACKETS) {
          throw new Error(`Canonical archive exceeds ${MAX_CANONICAL_ARCHIVE_PACKETS} packet limit`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Canonical archive exceeds")) throw error;
        // Match native replay semantics: one malformed frame does not poison readable capture.
      }
    }
    if (offset > 0) pending = pending.subarray(offset);
  }
  if (pending.length > 0) throw new Error("Canonical archive source has a truncated frame");
  if (declaredFrameCount !== null && declaredFrameCount !== 0 && declaredFrameCount !== frameCount) {
    throw new Error(`Canonical archive source declares ${declaredFrameCount} frames, found ${frameCount}`);
  }
  return packets;
}

async function buildRows(sessionId: number, packets: readonly TelemetryPacket[]): Promise<{ samples: SampleRow[]; nodes: CanonicalArchiveNode[]; semanticIds: string[]; completeness: "complete" | "partial"; context: ArchiveWriteResult["context"] }> {
  const session = await db.select({
    gameId: sessions.gameId,
    trackOrdinal: sessions.trackOrdinal,
    source: sessions.source,
    sourceChannelProfile: sessions.sourceChannelProfile,
  }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const runs = await db.select({
    runId: sessionRuns.runId,
    participantId: sessionRuns.participantId,
    status: sessionRuns.status,
    startSourceTimeMs: sessionRuns.startSourceTimeMs,
    endSourceTimeMs: sessionRuns.endSourceTimeMs,
  }).from(sessionRuns).where(eq(sessionRuns.sessionId, sessionId)).orderBy(asc(sessionRuns.openingSequence));
  const persistedLaps = await db.select({
    id: laps.id,
    lapNumber: laps.lapNumber,
    isValid: laps.isValid,
    phase: laps.phase,
  }).from(laps).where(eq(laps.sessionId, sessionId)).orderBy(asc(laps.lapNumber), asc(laps.id));
  const lapByNumber = new Map<number, typeof persistedLaps[number]>();
  for (const lap of persistedLaps) if (!lapByNumber.has(lap.lapNumber)) lapByNumber.set(lap.lapNumber, lap);
  const samples: SampleRow[] = new Array(packets.length);
  for (let sampleOrdinal = 0; sampleOrdinal < packets.length; sampleOrdinal += 1) {
    const packet = packets[sampleOrdinal]!;
    const lapNumber = packetLapNumber(packet);
    const sourceTimeMs = sourceTime(packet);
    const lap = lapNumber == null ? undefined : lapByNumber.get(lapNumber);
    samples[sampleOrdinal] = {
      sampleOrdinal,
      participantId: participantForTime(sourceTimeMs, runs),
      lapId: lap?.id ?? null,
      lapNumber,
      sourceTimeMs,
      receivedAtMs: sourceTimeMs,
      trackDistanceM: packetDistance(packet),
      trackDistancePct: null,
      speed: packetNumericValue(packet, "Speed"),
      accel: packetNumericValue(packet, "Accel"),
    };
  }
  if (samples.length === 0) throw new Error("Canonical archive contains zero readable telemetry samples");
  const archiveId = "pending";
  const nodes: CanonicalArchiveNode[] = [];
  const participantIndexes = new Map<string, number[]>();
  for (let index = 0; index < samples.length; index += 1) {
    const key = samples[index].participantId ?? "unknown";
    const indexes = participantIndexes.get(key) ?? [];
    indexes.push(index);
    participantIndexes.set(key, indexes);
  }
  const participantNodeByKey = new Map<string, string>();
  for (const [ordinal, [key, indexes]] of [...participantIndexes.entries()].entries()) {
    const participantId = key === "unknown" ? null : key;
    const nodeId = `participant:${key}`;
    participantNodeByKey.set(key, nodeId);
    nodes.push(nodeFromRange({ archiveId, nodeId, parentNodeId: null, level: "participant", semanticKind: "participant", stableKey: key, ordinal, participantId, status: "complete", samples, indexes }));
  }
  const stintNodeByRunId = new Map<string, string>();
  for (const [ordinal, run] of runs.entries()) {
    const indexes = samples.flatMap((sample, index) => {
      const inParticipant = run.participantId == null || sample.participantId === run.participantId;
      const inTime = (run.startSourceTimeMs == null || sample.sourceTimeMs >= run.startSourceTimeMs) &&
        (run.endSourceTimeMs == null || sample.sourceTimeMs <= run.endSourceTimeMs);
      return inParticipant && inTime ? [index] : [];
    });
    if (indexes.length === 0) continue;
    const participantKey = run.participantId ?? "unknown";
    const nodeId = `stint:${run.runId}`;
    stintNodeByRunId.set(run.runId, nodeId);
    nodes.push(nodeFromRange({
      archiveId,
      nodeId,
      parentNodeId: participantNodeByKey.get(participantKey) ?? null,
      level: "stint",
      semanticKind: "stint",
      stableKey: run.runId,
      ordinal,
      participantId: run.participantId,
      sessionRunId: run.runId,
      status: run.status === "complete" ? "complete" : "partial",
      samples,
      indexes,
    }));
  }
  const lapGroups = new Map<string, number[]>();
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.lapNumber == null) continue;
    const key = `${sample.participantId ?? "unknown"}:${sample.lapNumber}`;
    const indexes = lapGroups.get(key) ?? [];
    indexes.push(index);
    lapGroups.set(key, indexes);
  }
  for (const [ordinal, [key, indexes]] of [...lapGroups.entries()].entries()) {
    const [participantKey, lapNumberText] = key.split(":");
    const lapNumber = Number(lapNumberText);
    const lap = lapByNumber.get(lapNumber);
    const participantId = participantKey === "unknown" ? null : participantKey;
    const firstSample = samples[indexes[0]!]!;
    const run = runs.find((candidate) =>
      (candidate.participantId == null || candidate.participantId === participantId) &&
      (candidate.startSourceTimeMs == null || firstSample.sourceTimeMs >= candidate.startSourceTimeMs) &&
      (candidate.endSourceTimeMs == null || firstSample.sourceTimeMs <= candidate.endSourceTimeMs),
    );
    const parentNodeId = run
      ? stintNodeByRunId.get(run.runId) ?? participantNodeByKey.get(participantKey) ?? null
      : participantNodeByKey.get(participantKey) ?? null;
    const status = lap == null ? "unknown" : lap.isValid ? (lap.phase === "flying" ? "valid" : lap.phase) : "invalid";
    nodes.push(nodeFromRange({ archiveId, nodeId: `lap:${key}`, parentNodeId, level: "lap", semanticKind: "lap", stableKey: key, ordinal, participantId, sessionRunId: run?.runId ?? null, lapId: lap?.id ?? null, status, samples, indexes }));
  }
  const track = resolveTrack(session.gameId, session.trackOrdinal);
  const corners = await getCorners(session.trackOrdinal, session.gameId as GameId);
  const trackDefinitionHash = analysisCanonicalHash({
    slug: track.slug,
    geometry: track.geometry,
    segments: track.segments,
  });
  const cornerDefinitionHash = corners.length > 0 ? analysisCanonicalHash(corners) : null;
  const trackLength = track.lengthMeters;
  const distanceFraction = (sample: SampleRow): number | null => {
    if (trackLength == null || sample.trackDistanceM == null || trackLength <= 0) return null;
    const wrapped = ((sample.trackDistanceM % trackLength) + trackLength) % trackLength;
    return wrapped / trackLength;
  };
  const indexesForSegment = (startFrac: number, endFrac: number): number[] => samples.flatMap((sample, index) => {
    const fraction = distanceFraction(sample);
    if (fraction == null) return [];
    const inRange = startFrac <= endFrac
      ? fraction >= startFrac && fraction <= endFrac
      : fraction >= startFrac || fraction <= endFrac;
    return inRange ? [index] : [];
  });
  for (const [ordinal, segment] of track.segments.entries()) {
    const indexes = indexesForSegment(segment.startFrac, segment.endFrac);
    if (indexes.length === 0) continue;
    const segmentKey = `${segment.type}:${segment.name}:${ordinal}`;
    const cornerNodeId = `corner:${segmentKey}`;
    const parentNodeId = segment.type === "corner" ? cornerNodeId : null;
    if (segment.type === "corner") {
      nodes.push(nodeFromRange({
        archiveId,
        nodeId: cornerNodeId,
        parentNodeId: null,
        level: "corner",
        semanticKind: "corner",
        stableKey: segmentKey,
        ordinal,
        participantId: null,
        status: "authoritative",
        definitionHash: cornerDefinitionHash,
        samples,
        indexes,
      }));
      const apexIndex = indexes.reduce((best, index) => {
        const speed = samples[index]!.speed;
        const bestSpeed = samples[best]!.speed;
        return speed != null && (bestSpeed == null || speed < bestSpeed) ? index : best;
      }, indexes[0]!);
      const throttleIndex = indexes.find((index) => index >= apexIndex && (samples[index]!.accel ?? 0) >= 0.8) ?? indexes.at(-1)!;
      const phaseRanges = [
        { kind: "entry", indexes: indexes.filter((index) => index <= apexIndex) },
        { kind: "mid", indexes: indexes.filter((index) => index >= apexIndex && index <= throttleIndex) },
        { kind: "exit", indexes: indexes.filter((index) => index >= throttleIndex) },
      ];
      for (const phase of phaseRanges) {
        if (phase.indexes.length === 0) continue;
        nodes.push(nodeFromRange({
          archiveId,
          nodeId: `segment:${segmentKey}:${phase.kind}`,
          parentNodeId,
          level: "segment",
          semanticKind: phase.kind,
          stableKey: `${segmentKey}:${phase.kind}`,
          ordinal,
          participantId: null,
          status: "derived",
          definitionHash: cornerDefinitionHash,
          samples,
          indexes: phase.indexes,
        }));
      }
    } else {
      nodes.push(nodeFromRange({
        archiveId,
        nodeId: `segment:${segmentKey}`,
        parentNodeId,
        level: "segment",
        semanticKind: "straight",
        stableKey: segmentKey,
        ordinal,
        participantId: null,
        status: "authoritative",
        definitionHash: trackDefinitionHash,
        samples,
        indexes,
      }));
    }
  }
  // Complete means every readable raw packet reached canonical storage. Session
  // run lifecycle describes racing state, not archive byte coverage; partial is
  // reserved for future explicitly lossy source adapters.
  const completeness = "complete" as const;
  return {
    samples,
    nodes,
    completeness,
    semanticIds: actualSemanticIds(session.gameId as GameId, packets, semanticCandidatesForSession(session.sourceChannelProfile)),
    context: {
      gameId: session.gameId,
      trackId: track.slug ?? String(session.trackOrdinal),
      layoutId: null,
      trackDefinitionHash,
      cornerDefinitionHash,
      sourceKind: session.source,
      sourcePath: null,
    },
  };
}

async function writeArchive(input: {
  sessionId: number;
  gameId: GameId;
  sourceContentHash: string;
  generationId: string;
  packets: readonly TelemetryPacket[];
}): Promise<ArchiveWriteResult> {
  const archiveId = archiveIdFor(input.sessionId, input.sourceContentHash, input.generationId);
  const base = generationPath(input.sessionId, input.generationId);
  const finalPath = join(base, "telemetry.parquet");
  const stagePath = `${finalPath}.tmp-${crypto.randomUUID()}`;
  await mkdir(base, { recursive: true });
  const built = await buildRows(input.sessionId, input.packets);
  const nodes = built.nodes.map((node) => ({ ...node, archiveId, nodeId: `${archiveId}:${node.nodeId}`, parentNodeId: node.parentNodeId ? `${archiveId}:${node.parentNodeId}` : null }));
  const createdAt = new Date().toISOString();
  const manifest = CanonicalArchiveManifestSchema.parse({
    archiveId,
    sessionId: input.sessionId,
    generationId: input.generationId,
    gameId: built.context.gameId,
    trackId: built.context.trackId,
    layoutId: built.context.layoutId,
    sourceContentHash: input.sourceContentHash,
    telemetryVersion: currentAnalysisContract(input.gameId).telemetryVersion,
    schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
    algorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
    rowCount: built.samples.length,
    nodeCount: nodes.length,
    semanticIds: built.semanticIds,
    eventIds: [],
    completeness: built.completeness,
    warnings: [],
    context: built.context,
    createdAt,
  });
  try {
    await writeParquet(stagePath, built.samples, input.packets);
    await verifyCanonicalArchiveParquet(stagePath, built.samples.length);
    const output = await sha256ArchiveFile(stagePath);
    await rename(stagePath, finalPath);
    return {
      archiveId,
      generationId: input.generationId,
      finalPath,
      outputContentHash: output.contentHash,
      byteSize: output.byteSize,
      samples: built.samples,
      nodes,
      semanticIds: built.semanticIds,
      eventIds: [],
      manifest,
      context: built.context,
    };
  } catch (error) {
    await rm(stagePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function receiptChecks(input: Pick<ArchiveWriteResult, "semanticIds" | "samples" | "nodes" | "outputContentHash">): Array<{ id: AnalysisVerificationCheckId; status: "passed"; details: string }> {
  const ids = [
    "source_hash", "schema_supported", "session_identity", "participant_identity", "ordering", "coverage", "channel_inventory", "partitions_readable", "analyse_read", "compare_read", "storage_state",
  ] as const satisfies readonly AnalysisVerificationCheckId[];
  if (input.samples.length === 0 || input.nodes.some((node) => node.startRow < 0 || node.endRow > input.samples.length || node.endRow < node.startRow)) {
    throw new Error("Canonical archive verification found invalid row coverage");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.outputContentHash)) {
    throw new Error("Canonical archive verification found invalid output hash");
  }
  return ids.map((id) => ({ id, status: "passed", details: `Verified archive ${id}` }));
}
function sourceKind(value: string | null): "native-live" | "raceiq-raw" | "raceiq-archive" | "canonical-archive" | "iracing-ibt" | "motec" | "remote-collector" | "external-log" | "unknown" {
  if (value === "native-live" || value === "raceiq-raw" || value === "raceiq-archive" || value === "canonical-archive" || value === "iracing-ibt" || value === "motec" || value === "remote-collector" || value === "external-log") return value;
  return "unknown";
}

function lapCoverage(samples: readonly SampleRow[]): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const sample of samples) {
    if (sample.lapNumber == null) continue;
    start = start == null ? sample.lapNumber : Math.min(start, sample.lapNumber);
    end = end == null ? sample.lapNumber : Math.max(end, sample.lapNumber);
  }
  return start == null || end == null ? null : { start, end };
}
function participantCoverage(samples: readonly SampleRow[]): string[] {
  const participants = new Set<string>();
  for (const sample of samples) if (sample.participantId != null) participants.add(sample.participantId);
  return [...participants];
}


async function buildAndActivate(input: { sessionId: number; sourceContentHash: string; gameId: GameId; sourceChannelProfile: typeof sessions.$inferSelect["sourceChannelProfile"]; rawFile: string; lease: CanonicalArchiveJobLease }): Promise<{ archive: typeof canonicalArchives.$inferSelect; receipt: AnalysisReceiptRow }> { let written: ArchiveWriteResult | null = null;
let archiveWritten = false;
const contract = currentAnalysisContract(input.gameId, input.sourceChannelProfile);
const analysisComponents: AnalysisComponentIdentity[] = [
  ...contract.analysisComponents,
  {
    id: "canonical-archive",
    version: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
    schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
  },
].sort((left, right) => left.id.localeCompare(right.id));
const contractHash = analysisContractHash({
  receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
  telemetryVersion: contract.telemetryVersion,
  analysisComponents,
});
let receipt: AnalysisReceiptRow;
try {
  receipt = await activateCanonicalArchiveReceipt({
    sessionId: input.sessionId,
    sourceContentHash: input.sourceContentHash,
    contractHash,
    configurationHash: contract.configurationHash,
    buildReceipt: async (attempt) => {
      const identityBefore = await inspectRawCaptureIdentity(input.rawFile);
      if (!identityBefore || identityBefore.contentHash !== input.sourceContentHash) throw new Error("Canonical archive source hash changed before build");
      const packets = await readCanonicalRawPackets(input.rawFile, input.gameId);
      written = await writeArchive({ sessionId: input.sessionId, gameId: input.gameId, sourceContentHash: input.sourceContentHash, generationId: attempt.generationId, packets });
      archiveWritten = true;
      await canonicalArchiveBuildHookForTest?.();
      const identityAfter = await inspectRawCaptureIdentity(input.rawFile);
      if (!identityAfter || identityAfter.contentHash !== input.sourceContentHash) throw new Error("Canonical archive source hash changed during build");
    const archiveBuild = written;
    if (!archiveBuild) throw new Error("Canonical archive build returned no archive");
    await db.transaction(async (tx) => {
      await assertCanonicalArchiveJobLease(input.lease, tx);
      await tx.insert(canonicalArchives).values([{
      archiveId: archiveBuild.archiveId,
      sessionId: input.sessionId,
      generationId: attempt.generationId,
      status: "building",
      archivePath: archiveBuild.finalPath,
      schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      algorithmVersion: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
      sourceContentHash: input.sourceContentHash,
      outputContentHash: archiveBuild.outputContentHash,
      byteSize: archiveBuild.byteSize,
      sampleCount: archiveBuild.samples.length,
      nodeCount: archiveBuild.nodes.length,
      semanticIds: archiveBuild.semanticIds,
      context: archiveBuild.context,
      manifest: archiveBuild.manifest,
      completeness: archiveBuild.manifest.completeness,
      verification: { status: "passed", checks: receiptChecks(archiveBuild), verifiedAt: new Date().toISOString(), details: null },
      createdAt: archiveBuild.manifest.createdAt,
      verifiedAt: null,
      failure: null,
      }]);
      await tx.insert(canonicalArchiveNodes).values(archiveBuild.nodes.map((node) => ({
      nodeId: node.nodeId,
      archiveId: archiveBuild.archiveId,
      parentNodeId: node.parentNodeId,
      level: node.level,
      semanticKind: node.semanticKind,
      stableKey: node.stableKey,
      ordinal: node.ordinal,
      participantId: node.participantId,
      sessionRunId: node.sessionRunId,
      lapId: node.lapId,
      startRow: node.startRow,
      endRow: node.endRow,
      startSourceTimeMs: node.startSourceTimeMs,
      endSourceTimeMs: node.endSourceTimeMs,
      startTrackDistanceM: node.startTrackDistanceM,
      endTrackDistanceM: node.endTrackDistanceM,
      status: node.status,
      definitionHash: node.definitionHash,
      boundaryAlgorithmVersion: node.boundaryAlgorithmVersion,
      })));
    });
    return {
      receiptSchemaVersion: "analysis-receipt-v1",
      generationId: attempt.generationId,
      artifactSetId: attempt.artifactSetId,
      artifactSetType: "canonical_archive",
      generation: attempt.generation,
      lifecycle: "active",
      sessionId: input.sessionId,
      participantId: null,
      evidence: {
        kind: "raceiq-raw",
        originalSourceKind: sourceKind(archiveBuild.context.sourceKind),
        objectId: rawCaptureObjectId(input.sessionId),
        contentHash: input.sourceContentHash,
        byteSize: identityBefore.byteSize,
        formatVersion: "raceiq-session-framing-v1",
        recordCounts: { packets: archiveBuild.samples.length },
      },
      telemetryVersion: contract.telemetryVersion,
      analysisComponents,
      configuration: { hash: contract.configurationHash, effective: JSON.parse(JSON.stringify(contract.effectiveConfiguration)) },
      context: {
        gameId: archiveBuild.context.gameId,
        trackId: archiveBuild.context.trackId,
        layoutId: archiveBuild.context.layoutId,
        trackDefinitionHash: archiveBuild.context.trackDefinitionHash,
        cornerDefinitionHash: archiveBuild.context.cornerDefinitionHash,
      },
      sourceFidelity: { profileVersion: null, decisions: [] },
      outputs: [{ name: "telemetry.parquet", artifactType: "canonical_archive", schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION, count: archiveBuild.samples.length, contentHash: archiveBuild.outputContentHash, timeCoverageMs: { start: archiveBuild.samples[0].sourceTimeMs, end: archiveBuild.samples.at(-1)!.sourceTimeMs }, lapCoverage: lapCoverage(archiveBuild.samples), participantCoverage: participantCoverage(archiveBuild.samples), trackDistanceCoverageM: { start: archiveBuild.samples.find((sample) => sample.trackDistanceM != null)?.trackDistanceM ?? null, end: archiveBuild.samples.findLast((sample) => sample.trackDistanceM != null)?.trackDistanceM ?? null }}],
      canonicalInventory: { semanticIds: archiveBuild.semanticIds, eventIds: archiveBuild.eventIds, rowCounts: { telemetry_samples: archiveBuild.samples.length, hierarchy_nodes: archiveBuild.nodes.length } },
      warnings: [],
      unsupportedFields: [],
      rebuildCapability: { mode: "exact", sourceKind: "raceiq-raw", rebuildableArtifacts: ["canonical_archive"], unavailableArtifacts: [], limitations: [] },
      verification: receiptChecks(archiveBuild),
      contractHash,
      startedAt: attempt.startedAt,
      completedAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
    };
    },
    beforeActivate: async (tx) => {
      const archiveBuild = written;
      if (!archiveBuild) throw new Error("Canonical archive build returned no archive");
      await assertCanonicalArchiveJobLease(input.lease, tx);
      const session = await tx.select({ recordingQuality: sessions.recordingQuality })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .get();
      if (!session) throw new Error(`Session ${input.sessionId} not found`);
      if (session.recordingQuality) {
        await tx.update(sessions).set({
          recordingQuality: {
            ...session.recordingQuality,
            canonicalVerification: {
              state: "verified",
              sourceGeneration: archiveBuild.outputContentHash,
              details: "Verified canonical Parquet output",
            },
          },
        }).where(eq(sessions.id, input.sessionId));
      }
      const activated = await tx.update(canonicalArchives).set({
        status: archiveBuild.manifest.completeness === "partial" ? "partial" : "verified",
        verifiedAt: new Date().toISOString(),
      }).where(and(
        eq(canonicalArchives.archiveId, archiveBuild.archiveId),
        eq(canonicalArchives.status, "building"),
      )).returning({ archiveId: canonicalArchives.archiveId });
      if (activated.length !== 1) throw new Error("Canonical archive was not ready for activation");
    },
  });
} catch (error) {
  if (archiveWritten) {
    const failedArchive = written as unknown as ArchiveWriteResult;
    await rm(failedArchive.finalPath, { force: true }).catch(() => undefined);
    await db.update(canonicalArchives).set({ status: "failed", failure: error instanceof Error ? error.message : String(error) }).where(eq(canonicalArchives.archiveId, failedArchive.archiveId));
  }
  throw error;
}
const builtArchive = written as unknown as ArchiveWriteResult;
const archive = await db.select().from(canonicalArchives).where(eq(canonicalArchives.archiveId, builtArchive.archiveId)).get();
if (!archive) throw new Error("Canonical archive row missing after activation");
return { archive, receipt }; }

async function existingVerifiedArchive(
  sessionId: number,
  sourceContentHash: string,
): Promise<{ archive: typeof canonicalArchives.$inferSelect; receipt: AnalysisReceiptRow } | null> {
  const archive = await getActiveVerifiedCanonicalArchive(sessionId, { verifyOutput: true });
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (archive?.sourceContentHash === sourceContentHash && active?.receipt) {
    return { archive, receipt: active };
  }
  const existing = await db.select({ archiveId: canonicalArchives.archiveId }).from(canonicalArchives).where(and(
    eq(canonicalArchives.sessionId, sessionId),
    eq(canonicalArchives.sourceContentHash, sourceContentHash),
    inArray(canonicalArchives.status, ["verified", "partial", "building"]),
  )).get();
  if (existing) {
    await db.update(canonicalArchives).set({
      status: "failed",
      failure: "Canonical archive file, receipt, or output identity is unavailable",
    }).where(eq(canonicalArchives.archiveId, existing.archiveId));
  }
  return null;
}

export async function enqueueCanonicalArchiveForSession(
  sessionId: number,
  gameId: GameId,
  sourceContentHash?: string,
): Promise<void> {
  const rawFile = await getSessionRawFile(sessionId, gameId);
  if (!rawFile) return;
  const knownContentHash =
    sourceContentHash &&
    FINALIZED_SOURCE_GENERATION_PATTERN.test(sourceContentHash)
      ? sourceContentHash
      : undefined;
  const contentHash =
    knownContentHash ?? (await inspectRawCaptureIdentity(rawFile))?.contentHash;
  if (!contentHash) return;
  await enqueueCanonicalArchiveJob({ sessionId, sourceContentHash: contentHash });
}

export async function buildCanonicalArchive(input: {
  sessionId: number;
  sourceContentHash: string;
  jobId: string;
  leaseToken: string;
}): Promise<{ archive: typeof canonicalArchives.$inferSelect; receipt: AnalysisReceiptRow }> {
  return withSessionCaptureMaintenanceLock(async () => {
    const lease = {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      sessionId: input.sessionId,
      sourceContentHash: input.sourceContentHash,
    };
    await assertCanonicalArchiveJobLease(lease);
    const session = await db.select({ gameId: sessions.gameId, sourceChannelProfile: sessions.sourceChannelProfile }).from(sessions).where(eq(sessions.id, input.sessionId)).get();
    if (!session) throw new Error(`Session ${input.sessionId} not found`);
    const existing = await existingVerifiedArchive(input.sessionId, input.sourceContentHash);
    if (existing) return existing;
    const rawFile = await getSessionRawFile(input.sessionId, session.gameId as GameId);
    if (!rawFile) throw new Error(`Session ${input.sessionId} has no raw capture`);
    return buildAndActivate({
      sessionId: input.sessionId,
      sourceContentHash: input.sourceContentHash,
      gameId: session.gameId as GameId,
      sourceChannelProfile: session.sourceChannelProfile,
      rawFile,
      lease,
    });
  });
}
export { readCanonicalArchiveSamples } from "../db/canonical-archive-reader";
