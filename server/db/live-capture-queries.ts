import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { LiveArchiveMemberSchema, LiveArchiveSnapshotSchema, type LiveArchiveMember, type LiveArchiveSnapshot } from "@raceiq/capture-splitting";
import { db, client } from "./index";
import { laps, sessions, liveCaptures, liveCaptureMembers, liveCaptureJournal } from "./schema";
import type { GameId } from "@raceiq/shared/games/ids";
import { cacheDelete } from "./telemetry-replay-storage";

export interface LiveCaptureIdentity { sessionId: number; captureEpoch: string; attempt: string; }
export interface LiveCaptureProgress {
  sequence: number;
  sourceByteLength: number;
  sourceRecordCount: number;
  sourceDurableWatermark: number;
  metadataDurableWatermark: number;
}
export interface LiveCaptureWindow {
  kind: "window";
  revision: number;
  lapId: number;
  startByteOffset: number;
  frameCount: number;
  parserCheckpoint?: string;
  trailingContextFrameCount?: number;
}
function natural(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function fence(identity: LiveCaptureIdentity) {
  return and(eq(liveCaptures.sessionId, identity.sessionId), eq(liveCaptures.captureEpoch, identity.captureEpoch), eq(liveCaptures.attempt, identity.attempt));
}

/** Called outside ingress, before any member can be made visible. */
export async function beginLiveCapture(identity: LiveCaptureIdentity & { sourcePath: string; archivePath: string }): Promise<void> {
  if (!identity.captureEpoch || !identity.attempt || !identity.sourcePath || !identity.archivePath) throw new Error("Invalid live capture identity");
  // Local libSQL write transactions must not yield while ingress writes share the DB.
  const result = await client.batch([
    {
      sql: `INSERT INTO live_captures(session_id,capture_epoch,attempt,source_path,archive_path,status)
        SELECT id,?,?,?,?,'recording' FROM sessions
        WHERE id=? AND raw_file=? AND capture_layout_version IS NULL`,
      args: [identity.captureEpoch, identity.attempt, identity.sourcePath, identity.archivePath, identity.sessionId, identity.sourcePath],
    },
    {
      sql: "UPDATE sessions SET capture_layout_version=3,capture_archive_file=? WHERE id=? AND changes()=1",
      args: [identity.archivePath, identity.sessionId],
    },
  ], "write");
  if (result[0]!.rowsAffected !== 1 || result[1]!.rowsAffected !== 1) throw new Error("Live capture source changed before start");
}

/** Bind the worker-opened inode once; growth and header patching do not replace it. */
export async function bindLiveCaptureSourceIdentity(identity: LiveCaptureIdentity, device: string, inode: string): Promise<boolean> {
  if (!/^\d+$/.test(device) || !/^\d+$/.test(inode)) throw new Error("Invalid live source filesystem identity");
  const result = await db.update(liveCaptures).set({ sourceDevice: device, sourceInode: inode }).where(and(
    fence(identity),
    sql`(${liveCaptures.sourceDevice} IS NULL OR ${liveCaptures.sourceDevice} = ${device})`,
    sql`(${liveCaptures.sourceInode} IS NULL OR ${liveCaptures.sourceInode} = ${inode})`,
  )).run();
  return result.rowsAffected === 1;
}

/** File sync precedes this transaction; journal and its watermark commit together. */
export async function persistLiveCaptureProgress(
  identity: LiveCaptureIdentity,
  progress: LiveCaptureProgress,
  entries: readonly { sequence: number; sourceByteEnd: number; payload: unknown }[],
): Promise<boolean> {
  if (![progress.sequence, progress.sourceByteLength, progress.sourceRecordCount, progress.sourceDurableWatermark, progress.metadataDurableWatermark].every(natural) ||
      progress.metadataDurableWatermark > progress.sourceDurableWatermark || progress.sourceDurableWatermark > progress.sourceByteLength) throw new Error("Invalid live capture durability progress");
  let priorSequence = -1;
  const encoded = entries.map((entry) => {
    if (!natural(entry.sequence) || entry.sequence <= priorSequence || entry.sequence > progress.sequence || !natural(entry.sourceByteEnd) || entry.sourceByteEnd > progress.sourceDurableWatermark) throw new Error("Journal exceeds durable source prefix");
    priorSequence = entry.sequence;
    const payload = JSON.stringify(entry.payload);
    if (payload === undefined || Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error("Live capture journal entry exceeds limit");
    return { captureEpoch: identity.captureEpoch, sequence: entry.sequence, sourceByteEnd: entry.sourceByteEnd, payload };
  });
  const current = await db.select().from(liveCaptures).where(fence(identity)).get();
  if (!current || (current.status !== "recording" && current.status !== "finalizing") || progress.sequence < current.durableSequence ||
      progress.sourceByteLength < current.sourceByteLength || progress.sourceRecordCount < current.sourceRecordCount ||
      progress.sourceDurableWatermark < current.sourceDurableWatermark || progress.metadataDurableWatermark < current.metadataDurableWatermark) return false;
  for (const entry of encoded) {
    const existing = await db.select().from(liveCaptureJournal).where(and(eq(liveCaptureJournal.captureEpoch, identity.captureEpoch), eq(liveCaptureJournal.sequence, entry.sequence))).get();
    if (existing && (existing.payload !== entry.payload || existing.sourceByteEnd !== entry.sourceByteEnd)) throw new Error("Live capture journal sequence was reused");
  }
  const update = db.update(liveCaptures).set({
    sourceByteLength: progress.sourceByteLength, sourceRecordCount: progress.sourceRecordCount,
    sourceDurableWatermark: progress.sourceDurableWatermark, metadataDurableWatermark: progress.metadataDurableWatermark,
    durableSequence: progress.sequence,
  }).where(and(fence(identity), sql`${liveCaptures.status} IN ('recording','finalizing')`,
    sql`${liveCaptures.durableSequence} <= ${progress.sequence}`,
    sql`${liveCaptures.sourceByteLength} <= ${progress.sourceByteLength}`,
    sql`${liveCaptures.sourceRecordCount} <= ${progress.sourceRecordCount}`,
    sql`${liveCaptures.sourceDurableWatermark} <= ${progress.sourceDurableWatermark}`,
    sql`${liveCaptures.metadataDurableWatermark} <= ${progress.metadataDurableWatermark}`,
  )).toSQL();
  const gate = db.select({ one: sql`1` }).from(liveCaptures).where(and(
    fence(identity), sql`${liveCaptures.status} IN ('recording','finalizing')`,
    eq(liveCaptures.durableSequence, progress.sequence), eq(liveCaptures.sourceByteLength, progress.sourceByteLength),
    eq(liveCaptures.sourceRecordCount, progress.sourceRecordCount), eq(liveCaptures.sourceDurableWatermark, progress.sourceDurableWatermark),
    eq(liveCaptures.metadataDurableWatermark, progress.metadataDurableWatermark),
  )).toSQL();
  const statements = [{ sql: update.sql, args: update.params as (string | number | null)[] }];
  for (const entry of encoded) statements.push({
    sql: `INSERT INTO live_capture_journal(capture_epoch,sequence,source_byte_end,payload)
      SELECT ?,?,?,? WHERE EXISTS (${gate.sql}) AND NOT EXISTS (
        SELECT 1 FROM live_capture_journal WHERE capture_epoch=? AND sequence=? AND source_byte_end=? AND payload=?)`,
    args: [entry.captureEpoch, entry.sequence, entry.sourceByteEnd, entry.payload, ...gate.params as (string | number | null)[],
      entry.captureEpoch, entry.sequence, entry.sourceByteEnd, entry.payload],
  });
  return (await client.batch(statements, "write"))[0]!.rowsAffected === 1;
}

export interface LiveMemberVerification {
  nativeDigest: string;
  parserReplayVerified: boolean;
  parserReplayEvidence?: {
    sourceFrameCount: number;
    parsedFrameCount: number;
    nullFrameCount: number;
    orderedTelemetryDigest?: string;
  };
}

export interface LiveMemberCommit {
  identity: LiveCaptureIdentity;
  priorGeneration: number;
  member: LiveArchiveMember;
  verification: LiveMemberVerification;
  ownershipRevision: number;
  ownershipJournalSequence?: number;
  expectedWindow?: { lapId: number; startByteOffset: number; frameCount: number };
}

/** Only call after independent verification and archive fsync/directory durability. */
export async function commitLiveCaptureMember(input: LiveMemberCommit): Promise<boolean> {
  const member = Schema.decodeSync(LiveArchiveMemberSchema)(input.member);
  if (!natural(input.priorGeneration) || !natural(input.ownershipRevision) || member.generation !== input.priorGeneration + 1) throw new Error("Invalid live member generation");
  const verification = input.verification;
  if (!/^[a-f0-9]{64}$/.test(verification.nativeDigest)) throw new Error("Missing native semantic verification digest");
  if (member.kind === "lap") {
    const evidence = verification.parserReplayEvidence;
    if (!verification.parserReplayVerified || !evidence || !natural(evidence.sourceFrameCount) ||
        !natural(evidence.parsedFrameCount) || !natural(evidence.nullFrameCount) ||
        evidence.parsedFrameCount + evidence.nullFrameCount !== evidence.sourceFrameCount ||
        evidence.sourceFrameCount !== member.ownedFrameCount ||
        !/^[a-f0-9]{64}$/.test(evidence.orderedTelemetryDigest ?? "")) return false;
  }
  const current = await db.select().from(liveCaptures).where(fence(input.identity)).get();
  if (!current || current.sourceDevice === null || current.sourceInode === null ||
      (current.status !== "recording" && current.status !== "finalizing") || current.generation !== input.priorGeneration ||
      member.memberOffset !== current.committedArchiveLength || member.sourceByteEnd > current.metadataDurableWatermark ||
      member.sourceByteEnd > current.sourceDurableWatermark) return false;
  const lapId = member.lapId === undefined ? null : Number(member.lapId);
  let ownershipGuard;
  if (member.kind === "lap") {
    const expected = input.expectedWindow;
    if (!expected || lapId !== expected.lapId || !Number.isSafeInteger(lapId) || input.ownershipJournalSequence === undefined) return false;
    const journal = await db.select().from(liveCaptureJournal).where(and(eq(liveCaptureJournal.captureEpoch, input.identity.captureEpoch), eq(liveCaptureJournal.sequence, input.ownershipJournalSequence))).get();
    if (!journal || journal.sequence > current.durableSequence || journal.sourceByteEnd > current.metadataDurableWatermark) return false;
    const window = JSON.parse(journal.payload) as LiveCaptureWindow;
    if (window.kind !== "window" || window.revision !== input.ownershipRevision || window.lapId !== lapId ||
        window.startByteOffset !== expected.startByteOffset || window.frameCount !== expected.frameCount) return false;
    const lap = await db.select({ sessionId: laps.sessionId, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount }).from(laps).where(eq(laps.id, lapId!)).get();
    if (!lap || lap.sessionId !== input.identity.sessionId || lap.rawByteOffset !== expected.startByteOffset || lap.rawFrameCount !== expected.frameCount) return false;
    if (member.sourceByteStart !== expected.startByteOffset || member.ownedFrameCount == null || member.ownedFrameByteOffset == null ||
        (member.ownedFrameCount !== expected.frameCount && !(member.trailingContextFrameCount === 1 && member.ownedFrameCount === expected.frameCount - 1))) return false;
    ownershipGuard = sql`EXISTS (SELECT 1 FROM ${liveCaptureJournal}
      WHERE ${liveCaptureJournal.captureEpoch} = ${input.identity.captureEpoch} AND ${liveCaptureJournal.sequence} = ${input.ownershipJournalSequence}
        AND ${liveCaptureJournal.payload} = ${journal.payload} AND ${liveCaptureJournal.sequence} <= ${liveCaptures.durableSequence}
        AND ${liveCaptureJournal.sourceByteEnd} <= ${liveCaptures.metadataDurableWatermark})
      AND EXISTS (SELECT 1 FROM ${laps} WHERE ${laps.id} = ${lapId} AND ${laps.sessionId} = ${input.identity.sessionId}
        AND ${laps.rawByteOffset} = ${expected.startByteOffset} AND ${laps.rawFrameCount} = ${expected.frameCount}
        AND ${laps.captureChunkId} IS NULL)`;
  } else if (lapId !== null || input.expectedWindow !== undefined) return false;
  const end = member.memberOffset + member.compressedByteLength;
  if (!natural(end)) throw new Error("Live archive offset overflow");
  const claim = db.update(liveCaptures).set({ generation: member.generation, committedArchiveLength: end }).where(and(
    fence(input.identity), eq(liveCaptures.generation, input.priorGeneration), eq(liveCaptures.committedArchiveLength, member.memberOffset),
    sql`${liveCaptures.status} IN ('recording','finalizing')`, sql`${liveCaptures.sourceDevice} IS NOT NULL`,
    sql`${liveCaptures.sourceInode} IS NOT NULL`, sql`${liveCaptures.metadataDurableWatermark} >= ${member.sourceByteEnd}`,
    sql`${liveCaptures.sourceDurableWatermark} >= ${member.sourceByteEnd}`, ownershipGuard,
  )).toSQL();
  const statements = [
    { sql: claim.sql, args: claim.params as (string | number | null)[] },
    {
      sql: `INSERT INTO live_capture_members(capture_epoch,generation,lap_id,ownership_revision,descriptor,verification)
        SELECT ?,?,?,?,?,? WHERE changes()=1`,
      args: [input.identity.captureEpoch, member.generation, lapId, input.ownershipRevision, JSON.stringify(member), JSON.stringify(verification)],
    },
  ];
  if (lapId !== null) statements.push({
    sql: "UPDATE laps SET capture_chunk_id=?,source_frame_start=NULL,source_frame_count=? WHERE id=? AND changes()=1",
    args: [member.id, member.ownedFrameCount!, lapId],
  });
  const result = await client.batch(statements, "write");
  const committed = result[0]!.rowsAffected === 1;
  if (committed && (result[1]!.rowsAffected !== 1 || (lapId !== null && result[2]!.rowsAffected !== 1))) throw new Error("Live publication batch did not bind every row");
  if (committed && input.member.lapId !== undefined) cacheDelete(Number(input.member.lapId));
  return committed;
}

/** One joined SQLite statement gives descriptor and progress the same snapshot. */
export async function getLiveLapCaptureSnapshot(sessionId: number, lapId: number): Promise<{ archivePath: string; snapshot: LiveArchiveSnapshot } | null> {
  const row = await db.select({ capture: liveCaptures, descriptor: liveCaptureMembers.descriptor, gameId: sessions.gameId }).from(liveCaptures)
    .innerJoin(sessions, eq(sessions.id, liveCaptures.sessionId))
    .innerJoin(liveCaptureMembers, and(eq(liveCaptureMembers.captureEpoch, liveCaptures.captureEpoch), eq(liveCaptureMembers.lapId, lapId)))
    .innerJoin(laps, and(eq(laps.id, liveCaptureMembers.lapId), eq(laps.sessionId, sessions.id), sql`${laps.captureChunkId} IS NOT NULL`))
    .where(and(eq(liveCaptures.sessionId, sessionId), eq(sessions.captureLayoutVersion, 3))).get();
  if (!row) return null;
  const capture = row.capture;
  const snapshot = Schema.decodeUnknownSync(LiveArchiveSnapshotSchema)({ version: 5, gameId: row.gameId as GameId,
    captureEpoch: capture.captureEpoch, attempt: capture.attempt, generation: capture.generation,
    committedArchiveLength: capture.committedArchiveLength, sourceDurableWatermark: capture.sourceDurableWatermark,
    metadataDurableWatermark: capture.metadataDurableWatermark, sourceRevision: capture.captureEpoch,
    sourceByteLength: capture.sourceByteLength, sourceRecordCount: capture.sourceRecordCount,
    archiveFile: "capture.bin.gz", sealed: capture.status === "sealed", member: JSON.parse(row.descriptor) });
  return { archivePath: capture.archivePath, snapshot };
}

export async function setLiveCaptureStatus(identity: LiveCaptureIdentity, status: "finalizing" | "failed" | "recovering", error?: string): Promise<boolean> {
  const result = await db.update(liveCaptures).set({ status, error: error?.slice(0, 2000) ?? null }).where(and(fence(identity), sql`${liveCaptures.status} <> 'sealed'`)).run();
  return result.rowsAffected === 1;
}
