import { open, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Schema } from "effect";
import { LiveArchiveMemberSchema } from "@raceiq/capture-splitting";
import { syncDirectory } from "@raceiq/capture-formats/session/durable-directory";
import { db, client } from "../db/index";
import { laps, sessions, liveCaptures, liveCaptureMembers } from "../db/schema";
import type { LiveCaptureIdentity } from "../db/live-capture-queries";

/** Stream final metadata once; never reopen source records or recompress archive members. */
export async function sealLiveCaptureMetadata(identity: LiveCaptureIdentity): Promise<void> {
  const fence = and(eq(liveCaptures.sessionId, identity.sessionId), eq(liveCaptures.captureEpoch, identity.captureEpoch), eq(liveCaptures.attempt, identity.attempt));
  const capture = await db.select({ capture: liveCaptures, gameId: sessions.gameId }).from(liveCaptures)
    .innerJoin(sessions, eq(sessions.id, liveCaptures.sessionId)).where(fence).get();
  if (!capture || capture.capture.status !== "finalizing") throw new Error("Live capture is not finalizing");
  const progress = capture.capture;
  if (progress.sourceByteLength !== progress.sourceDurableWatermark || progress.sourceByteLength !== progress.metadataDurableWatermark) throw new Error("Live capture has an undurable source or ownership tail");
  const pending = await db.select({ count: sql<number>`count(*)` }).from(laps).where(and(eq(laps.sessionId, identity.sessionId), sql`${laps.captureChunkId} IS NULL`)).get();
  if (pending?.count) throw new Error("Live capture still has unpublished lap bindings");
  if (progress.sourceByteLength === 0 && progress.sourceRecordCount === 0 && progress.generation === 0 && progress.committedArchiveLength === 0) {
    const result = await db.update(liveCaptures).set({ status: "sealed", error: null })
      .where(and(fence, eq(liveCaptures.status, "finalizing"), eq(liveCaptures.sourceByteLength, 0),
        eq(liveCaptures.generation, 0), eq(liveCaptures.committedArchiveLength, 0))).run();
    if (result.rowsAffected !== 1) throw new Error("Empty live seal was fenced");
    return;
  }
  const info = await stat(progress.archivePath);
  if (!info.isFile() || info.size !== progress.committedArchiveLength) throw new Error("Live archive has an uncommitted final suffix");
  const manifestPath = join(dirname(progress.archivePath), "manifest.live.json");
  const temporaryPath = `${manifestPath}.${identity.attempt}.tmp`;
  const file = await open(temporaryPath, "wx");
  let generation = 0;
  let archiveEnd = 0;
  let sourceEnd = 0;
  const writeAll = async (text: string) => {
    const bytes = Buffer.from(text);
    let written = 0;
    while (written < bytes.length) {
      const result = await file.write(bytes, written, bytes.length - written);
      if (result.bytesWritten === 0) throw new Error("Live manifest write made no progress");
      written += result.bytesWritten;
    }
  };
  try {
    const header = JSON.stringify({ version: 5, gameId: capture.gameId, captureEpoch: identity.captureEpoch,
      attempt: identity.attempt, generation: progress.generation, committedArchiveLength: progress.committedArchiveLength,
      sourceDurableWatermark: progress.sourceDurableWatermark, metadataDurableWatermark: progress.metadataDurableWatermark,
      sourceRevision: identity.captureEpoch, sourceByteLength: progress.sourceByteLength,
      sourceRecordCount: progress.sourceRecordCount, archiveFile: "capture.bin.gz", sealed: true });
    await writeAll(`${header.slice(0, -1)},"members":[`);
    while (generation < progress.generation) {
      const rows = await db.select({ descriptor: liveCaptureMembers.descriptor }).from(liveCaptureMembers)
        .where(and(eq(liveCaptureMembers.captureEpoch, identity.captureEpoch), gt(liveCaptureMembers.generation, generation)))
        .orderBy(asc(liveCaptureMembers.generation)).limit(128).all();
      if (rows.length === 0) throw new Error("Live archive generation is missing a member");
      for (const row of rows) {
        const member = Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(row.descriptor));
        if (member.generation !== generation + 1 || member.memberOffset !== archiveEnd || member.sourceStart !== sourceEnd) throw new Error("Live archive ownership or physical prefix is not contiguous");
        await writeAll(`${generation === 0 ? "" : ","}${row.descriptor}`);
        generation = member.generation;
        archiveEnd += member.compressedByteLength;
        sourceEnd = member.sourceEnd;
      }
    }
    if (archiveEnd !== progress.committedArchiveLength) throw new Error("Live archive sealed length changed");
    if (sourceEnd !== progress.sourceRecordCount) throw new Error("Live archive does not cover the final native source record count");
    await writeAll("]}");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporaryPath, manifestPath);
  await syncDirectory(dirname(manifestPath));
  const seal = db.update(liveCaptures).set({ status: "sealed", error: null })
    .where(and(fence, eq(liveCaptures.status, "finalizing"), eq(liveCaptures.generation, progress.generation),
      eq(liveCaptures.committedArchiveLength, progress.committedArchiveLength))).toSQL();
  const manifest = db.update(sessions).set({ captureManifestFile: manifestPath })
    .where(and(eq(sessions.id, identity.sessionId), sql`changes()=1`)).toSQL();
  const result = await client.batch([
    { sql: seal.sql, args: seal.params as (string | number | null)[] },
    { sql: manifest.sql, args: manifest.params as (string | number | null)[] },
  ], "write");
  if (result[0]!.rowsAffected !== 1 || result[1]!.rowsAffected !== 1) throw new Error("Live seal generation was fenced");
}
