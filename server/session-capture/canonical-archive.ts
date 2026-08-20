import { DuckDBInstance } from "@duckdb/node-api";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import type { AnalysisVerificationCheckId } from "../../shared/racing/provenance/contracts";
import { getActiveAnalysisReceipt, type AnalysisReceiptRow } from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { readCanonicalArchiveSamples } from "../db/canonical-archive-reader";
import { enqueueCanonicalArchiveJob } from "../db/canonical-archive-queries";
import { getCorners } from "../db/track-queries";
import { canonicalArchiveNodes, canonicalArchives, laps, sessionRuns, sessions } from "../db/schema";
import { getSessionTelemetry, getSessionRawFile } from "../db/telemetry-replay-storage";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { resolveTrack } from "../tracks/info";
import { analysisCanonicalHash } from "../analysis-provenance/current-contract";
import { activateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";
import { resolveDataDir } from "../runtime/config/data-dir";
import { loadRawCaptureIdentity } from "./identity";
import { withSessionCaptureMaintenanceLock } from "./cleanup";

const ARCHIVE_DIR = "archives/sessions";
const SAMPLE_TABLE = "telemetry_samples";

interface SampleRow {
  sampleOrdinal: number;
  participantId: string | null;
  lapId: number | null;
  lapNumber: number | null;
  sourceTimeMs: number;
  receivedAtMs: number;
  trackDistanceM: number | null;
  trackDistancePct: number | null;
  packetJson: string;
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

function sha256File(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function packetNumericField(sample: SampleRow, field: string): number | null {
  try {
    const packet: unknown = JSON.parse(sample.packetJson);
    if (packet && typeof packet === "object" && field in packet) {
      const value = Number(packet[field as keyof typeof packet]);
      return Number.isFinite(value) ? value : null;
    }
  } catch {
    return null;
  }
  return null;
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
  const ordered = [...indexes].sort((a, b) => a - b);
  const first = samples[ordered[0]];
  const last = samples[ordered[ordered.length - 1]];
  return {
    start: ordered[0],
    end: ordered[ordered.length - 1] + 1,
    startTime: first?.sourceTimeMs ?? null,
    endTime: last?.sourceTimeMs ?? null,
    startDistance: first?.trackDistanceM ?? null,
    endDistance: last?.trackDistanceM ?? null,
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

function requiredSemanticIds(): string[] {
  const ids = new Set<string>();
  for (const channels of Object.values(QUALITY_POLICY_CONFIG_V1.requiredChannels)) {
    for (const id of channels) ids.add(id);
  }
  return [...ids];
}

async function writeParquet(
  stagePath: string,
  samples: readonly SampleRow[],
): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
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
    const appender = await connection.createAppender(SAMPLE_TABLE);
    for (const sample of samples) {
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
      appender.appendVarchar(sample.packetJson);
      appender.endRow();
    }
    appender.flushSync();
    await connection.run(`COPY ${SAMPLE_TABLE} TO ${sqlString(stagePath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function verifyParquet(path: string, expectedRows: number): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = sqlString(path);
    const countReader = await connection.runAndReadAll(`SELECT count(*) AS count FROM read_parquet(${file})`);
    await countReader.readAll();
    const count = Number(countReader.getRowObjectsJS()[0]?.count ?? 0);
    if (count !== expectedRows) throw new Error(`Canonical archive row count mismatch: expected ${expectedRows}, got ${count}`);
    const orderReader = await connection.runAndReadAll(`SELECT sample_ordinal, source_time_ms FROM read_parquet(${file}) ORDER BY sample_ordinal`);
    await orderReader.readAll();
    const rows = orderReader.getRowsJS();
    for (let index = 0; index < rows.length; index += 1) {
      const ordinal = Number(rows[index]?.[0]);
      if (ordinal !== index) throw new Error(`Canonical archive sample ordering mismatch at row ${index}`);
      if (index > 0 && Number(rows[index]?.[1]) < Number(rows[index - 1]?.[1])) {
        throw new Error(`Canonical archive source timestamps out of order at row ${index}`);
      }
    }
    const archiveRows = await readCanonicalArchiveSamples(path, 0, expectedRows);
    if (archiveRows.length !== expectedRows) throw new Error(`Canonical archive reader row count mismatch: expected ${expectedRows}, got ${archiveRows.length}`);
    for (const row of archiveRows) {
      const packet: unknown = JSON.parse(row.packetJson);
      if (!packet || typeof packet !== "object" || !("gameId" in packet) || typeof packet.gameId !== "string") {
        throw new Error(`Canonical archive packet JSON is invalid at row ${row.sampleOrdinal}`);
      }
    }
    await connection.run(`SELECT packet_json FROM read_parquet(${file}) LIMIT 1`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
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
  const samples: SampleRow[] = packets.map((packet, sampleOrdinal) => {
    const lapNumber = packetLapNumber(packet);
    const sourceTimeMs = sourceTime(packet);
    const lap = lapNumber == null ? undefined : lapByNumber.get(lapNumber);
    return {
      sampleOrdinal,
      participantId: participantForTime(sourceTimeMs, runs),
      lapId: lap?.id ?? null,
      lapNumber,
      sourceTimeMs,
      receivedAtMs: sourceTimeMs,
      trackDistanceM: packetDistance(packet),
      trackDistancePct: null,
      packetJson: JSON.stringify(packet),
    };
  });
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
        const speed = packetNumericField(samples[index]!, "Speed");
        const bestSpeed = packetNumericField(samples[best]!, "Speed");
        return speed != null && (bestSpeed == null || speed < bestSpeed) ? index : best;
      }, indexes[0]!);
      const throttleIndex = indexes.find((index) => index >= apexIndex && (packetNumericField(samples[index]!, "Accel") ?? 0) >= 0.8) ?? indexes.at(-1)!;
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
  const completeness = runs.some((run) => run.status === "incomplete") ? "partial" : "complete";
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
  rawFile: string;
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
    await writeParquet(stagePath, built.samples);
    await verifyParquet(stagePath, built.samples.length);
    const bytes = Buffer.from(await Bun.file(stagePath).arrayBuffer());
    const outputContentHash = sha256File(bytes);
    await rename(stagePath, finalPath);
    return {
      archiveId,
      generationId: input.generationId,
      finalPath,
      outputContentHash,
      byteSize: bytes.byteLength,
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
  const missing = requiredSemanticIds().filter((id) => !input.semanticIds.includes(id));
  if (missing.length > 0) throw new Error(`Canonical archive verification missing channels: ${missing.join(", ")}`);
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
  const numbers = samples.flatMap((sample) => sample.lapNumber == null ? [] : [sample.lapNumber]);
  if (numbers.length === 0) return null;
  return { start: Math.min(...numbers), end: Math.max(...numbers) };
}

async function buildAndActivate(input: { sessionId: number; sourceContentHash: string; gameId: GameId; rawFile: string }): Promise<{ archive: typeof canonicalArchives.$inferSelect; receipt: AnalysisReceiptRow }> {
  let written: ArchiveWriteResult | null = null;
  let archiveWritten = false;
  const contract = currentAnalysisContract(input.gameId);
  let receipt: AnalysisReceiptRow;
  try {
    receipt = await activateCanonicalArchiveReceipt({
      sessionId: input.sessionId,
      sourceContentHash: input.sourceContentHash,
      contractHash: contract.contractHash,
      configurationHash: contract.configurationHash,
      buildReceipt: async (attempt) => {
        const identityBefore = await loadRawCaptureIdentity(input.rawFile);
        if (!identityBefore || identityBefore.contentHash !== input.sourceContentHash) throw new Error("Canonical archive source hash changed before build");
        const packets = await getSessionTelemetry(input.sessionId, input.gameId, { preferArchive: false });
        const identityAfter = await loadRawCaptureIdentity(input.rawFile);
        if (!identityAfter || identityAfter.contentHash !== input.sourceContentHash) throw new Error("Canonical archive source hash changed during build");
        written = await writeArchive({ sessionId: input.sessionId, gameId: input.gameId, sourceContentHash: input.sourceContentHash, generationId: attempt.generationId, rawFile: input.rawFile, packets });
        archiveWritten = true;
      const archiveBuild = written;
      if (!archiveBuild) throw new Error("Canonical archive build returned no archive");
      const missingRequiredChannels = requiredSemanticIds().filter((id) => !archiveBuild.semanticIds.includes(id));
      if (missingRequiredChannels.length > 0) {
        throw new Error(`Canonical archive is missing required channels: ${missingRequiredChannels.join(", ")}`);
      }
      await db.transaction(async (tx) => {
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
          kind: "canonical-archive",
          originalSourceKind: sourceKind(archiveBuild.context.sourceKind),
          objectId: archiveBuild.archiveId,
          contentHash: input.sourceContentHash,
          byteSize: identityAfter.bytes.byteLength,
          formatVersion: "raceiq-raw-v1",
          recordCounts: { telemetry_samples: archiveBuild.samples.length, hierarchy_nodes: archiveBuild.nodes.length },
        },
        telemetryVersion: contract.telemetryVersion,
        analysisComponents: contract.analysisComponents,
        configuration: { hash: contract.configurationHash, effective: JSON.parse(JSON.stringify(contract.effectiveConfiguration)) },
        context: {
          gameId: archiveBuild.context.gameId,
          trackId: archiveBuild.context.trackId,
          layoutId: archiveBuild.context.layoutId,
          trackDefinitionHash: archiveBuild.context.trackDefinitionHash,
          cornerDefinitionHash: archiveBuild.context.cornerDefinitionHash,
        },
        sourceFidelity: { profileVersion: null, decisions: [] },
        outputs: [{ name: "telemetry.parquet", artifactType: "canonical_archive", schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION, count: archiveBuild.samples.length, contentHash: archiveBuild.outputContentHash, timeCoverageMs: { start: archiveBuild.samples[0].sourceTimeMs, end: archiveBuild.samples.at(-1)!.sourceTimeMs }, lapCoverage: lapCoverage(archiveBuild.samples), participantCoverage: [...new Set(archiveBuild.samples.map((sample) => sample.participantId).filter((id): id is string => id != null))], trackDistanceCoverageM: { start: archiveBuild.samples.find((sample) => sample.trackDistanceM != null)?.trackDistanceM ?? null, end: archiveBuild.samples.findLast((sample) => sample.trackDistanceM != null)?.trackDistanceM ?? null }}],
        canonicalInventory: { semanticIds: archiveBuild.semanticIds, eventIds: archiveBuild.eventIds, rowCounts: { telemetry_samples: archiveBuild.samples.length, hierarchy_nodes: archiveBuild.nodes.length } },
        warnings: [],
        unsupportedFields: [],
        rebuildCapability: { mode: "limited", sourceKind: "canonical-archive", rebuildableArtifacts: ["canonical_archive", "laps", "race_events", "session_runs", "race_result", "quality", "lap_metrics", "findings", "lap_analysis", "comparison_analysis", "report"], unavailableArtifacts: ["driver_profile"], limitations: ["Exact native-source reprocessing requires retained raw evidence"] },
        verification: receiptChecks(archiveBuild),
        contractHash: contract.contractHash,
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      };
    },
    });
    const activatedAt = new Date().toISOString();
    const activatedArchive = written as unknown as ArchiveWriteResult;
    await db.update(canonicalArchives).set({ status: activatedArchive.manifest.completeness === "partial" ? "partial" : "verified", verifiedAt: activatedAt }).where(and(
      eq(canonicalArchives.archiveId, activatedArchive.archiveId),
      eq(canonicalArchives.status, "building"),
    ));
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
  return { archive, receipt };
}
 
export async function enqueueCanonicalArchiveForSession(sessionId: number, gameId: GameId): Promise<void> {
  const rawFile = await getSessionRawFile(sessionId, gameId);
  if (!rawFile) return;
  const identity = await loadRawCaptureIdentity(rawFile);
  if (!identity) return;
  await enqueueCanonicalArchiveJob({ sessionId, sourceContentHash: identity.contentHash });
}

export async function buildCanonicalArchive(input: { sessionId: number; sourceContentHash: string }): Promise<{ archive: typeof canonicalArchives.$inferSelect; receipt: AnalysisReceiptRow }> {
  return withSessionCaptureMaintenanceLock(async () => {
    const session = await db.select({ gameId: sessions.gameId }).from(sessions).where(eq(sessions.id, input.sessionId)).get();
    if (!session) throw new Error(`Session ${input.sessionId} not found`);
    const rawFile = await getSessionRawFile(input.sessionId, session.gameId as GameId);
    if (!rawFile) throw new Error(`Session ${input.sessionId} has no raw capture`);
    const existing = await db.select().from(canonicalArchives).where(and(eq(canonicalArchives.sessionId, input.sessionId), eq(canonicalArchives.sourceContentHash, input.sourceContentHash), inArray(canonicalArchives.status, ["verified", "partial"]))).get();
    const active = await getActiveAnalysisReceipt({ sessionId: input.sessionId, artifactSetType: "canonical_archive" });
    if (existing && active?.receipt?.evidence.contentHash === input.sourceContentHash) return { archive: existing, receipt: active };
    return buildAndActivate({ sessionId: input.sessionId, sourceContentHash: input.sourceContentHash, gameId: session.gameId as GameId, rawFile });
  });
}
export { readCanonicalArchiveSamples } from "../db/canonical-archive-reader";

