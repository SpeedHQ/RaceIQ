import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { cacheDelete } from "./telemetry-replay-storage";
import { clearSessionCaptureCache, loadCaptureManifest } from "../session-capture/source-loader";
import type { DownsampleCaptureBundle } from "../session-capture/downsample-bundles";
import { and, eq, isNotNull, or, inArray, sql } from "drizzle-orm";
import { db, readDb } from "./index";
import { laps, sessions, lapMetrics, lapAnalyses, compareAnalyses, lineSpreadCache, dashboardSummaryState, sessionCaptureSplitJobs, liveCaptures, liveCaptureMembers, lapGuidReconciliation, originalActivitySourceLaps } from "./schema";
import type { RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import { withDatabaseWrite } from "./write-coordination";
import type { LapClassification } from "@raceiq/shared/racing/lap-classification";

type DownsampleLapIndex = {
  lapId: number;
  expectedRawByteOffset: number;
  expectedRawFrameCount: number;
};
type DownsampleLapRewrite = DownsampleLapIndex & { rawByteOffset: number; rawFrameCount: number };

async function validateDownsampleReferences(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  oldRawFile: string,
  sessionIds: number[],
  expectedIndexes: readonly DownsampleLapIndex[],
): Promise<{ sessionIds: number[]; lapRows: Array<{ id: number; sessionId: number; rawByteOffset: number | null; rawFrameCount: number | null; isFavorite: boolean; experimentId: number | null }> }> {
  const resolvedOldPath = resolve(oldRawFile);
  const allSessions = await tx.select({
    id: sessions.id, rawFile: sessions.rawFile, isFavorite: sessions.isFavorite,
  }).from(sessions).where(isNotNull(sessions.rawFile)).all();
  const references = allSessions.filter((row) => row.rawFile !== null && resolve(row.rawFile) === resolvedOldPath);
  const actualIds = references.map(({ id }) => id).sort((a, b) => a - b);
  const requestedIds = [...sessionIds].sort((a, b) => a - b);
  if (actualIds.length === 0 || new Set(requestedIds).size !== requestedIds.length || actualIds.length !== requestedIds.length ||
      actualIds.some((id, index) => id !== requestedIds[index])) {
    throw new Error("Downsample publication references changed");
  }
  const lapRows = await tx.select({
    id: laps.id, sessionId: laps.sessionId, rawByteOffset: laps.rawByteOffset,
    rawFrameCount: laps.rawFrameCount, isFavorite: laps.isFavorite, experimentId: laps.experimentId,
  }).from(laps).where(inArray(laps.sessionId, actualIds)).all();
  if (references.some(({ isFavorite }) => isFavorite) || lapRows.some(({ isFavorite }) => isFavorite)) {
    throw new Error("Downsample publication includes favorite recording");
  }
  const indexedRows = lapRows.filter((row) => row.rawByteOffset !== null);
  if (indexedRows.some((row) => row.rawFrameCount === null || !Number.isSafeInteger(row.rawByteOffset) ||
      !Number.isSafeInteger(row.rawFrameCount) || row.rawByteOffset! < 0 || row.rawFrameCount! <= 0)) {
    throw new Error("Downsample publication found invalid lap index");
  }
  const actualIndexes = indexedRows.map((row) => [row.id, row.rawByteOffset!, row.rawFrameCount!]).sort((a, b) => a[0]! - b[0]!);
  const wantedIndexes = expectedIndexes.map((row) => [row.lapId, row.expectedRawByteOffset, row.expectedRawFrameCount]).sort((a, b) => a[0]! - b[0]!);
  if (expectedIndexes.some((row) => !Number.isSafeInteger(row.expectedRawByteOffset) || row.expectedRawByteOffset < 0 ||
      !Number.isSafeInteger(row.expectedRawFrameCount) || row.expectedRawFrameCount <= 0) ||
      new Set(wantedIndexes.map(([id]) => id)).size !== wantedIndexes.length ||
      actualIndexes.length !== wantedIndexes.length ||
      actualIndexes.some((row, index) => row.some((value, column) => value !== wantedIndexes[index]![column]))) {
    throw new Error("Downsample publication lap indexes changed");
  }
  return { sessionIds: actualIds, lapRows };
}

export async function commitSessionDownsample(input: {
  oldRawFile: string;
  newRawFile: string;
  sessionIds: number[];
  targetHz: RecordingFrequencyHz;
  lapIndexes: ReadonlyArray<DownsampleLapRewrite>;
  captureBundles?: readonly DownsampleCaptureBundle[];
}): Promise<void> {
  const bundles = input.captureBundles ?? [];
  if (new Set(bundles.map((bundle) => bundle.sessionId)).size !== bundles.length) {
    throw new Error("Downsample publication includes duplicate bundles");
  }
  for (const bundle of bundles) {
    const persisted = await loadCaptureManifest(bundle.manifestPath);
    if (persisted.version !== 3 || JSON.stringify(persisted) !== JSON.stringify(bundle.manifest)) {
      throw new Error("Downsample publication manifest changed");
    }
    for (const chunk of persisted.chunks) {
      const info = await stat(join(dirname(bundle.manifestPath), chunk.path));
      if (!info.isFile() || info.size !== chunk.byteLength) throw new Error("Downsample publication chunk changed");
    }
  }
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    const checked = await validateDownsampleReferences(tx, input.oldRawFile, input.sessionIds, input.lapIndexes);
    const rewriteById = new Map(input.lapIndexes.map((index) => [index.lapId, index]));
    if (rewriteById.size !== input.lapIndexes.length ||
        checked.lapRows.some((row) => (row.rawByteOffset !== null) !== rewriteById.has(row.id)) ||
        input.lapIndexes.some((index) => !Number.isSafeInteger(index.rawByteOffset) || index.rawByteOffset < 0 ||
          !Number.isSafeInteger(index.rawFrameCount) || index.rawFrameCount <= 0)) {
      throw new Error("Downsample publication lap set changed");
    }
    const newResolvedPath = resolve(input.newRawFile);
    const allPaths = await tx.select({ id: sessions.id, rawFile: sessions.rawFile }).from(sessions).where(isNotNull(sessions.rawFile)).all();
    if (allPaths.some(({ id, rawFile }) => rawFile !== null && resolve(rawFile) === newResolvedPath &&
        !checked.sessionIds.includes(id)) || resolve(input.oldRawFile) === newResolvedPath) {
      throw new Error("Downsample publication target conflicts");
    }
    const bundleBySession = new Map(bundles.map((bundle) => [bundle.sessionId, bundle]));
    if (bundles.some((bundle) => !checked.sessionIds.includes(bundle.sessionId))) {
      throw new Error("Downsample publication bundle session changed");
    }
    for (const id of checked.sessionIds) {
      const current = await tx.select().from(sessions).where(eq(sessions.id, id)).get();
      const currentLaps = await tx.select().from(laps).where(eq(laps.sessionId, id)).all();
      const bundle = bundleBySession.get(id);
      if (!bundle) {
        if (current?.captureLayoutVersion != null || current?.captureManifestFile || current?.captureArchiveFile || currentLaps.some((lap) => lap.captureChunkId !== null)) {
          throw new Error("Downsample publication requires rewritten replay bundle");
        }
        continue;
      }
      if (!current || current.captureManifestFile !== bundle.expectedManifestFile ||
          current.captureArchiveFile !== bundle.expectedArchiveFile || current.captureLayoutVersion !== bundle.expectedLayoutVersion ||
          current.gameId !== bundle.manifest.gameId) {
        throw new Error("Downsample publication bundle references changed");
      }
      const expectedLaps = new Map(bundle.expectedLaps.map((lap) => [lap.id, lap]));
      const chunks = bundle.manifest.chunks.filter((chunk) => chunk.lapId !== undefined);
      const chunksByLap = new Map(chunks.map((chunk) => [Number(chunk.lapId), chunk]));
      if (expectedLaps.size !== currentLaps.length || chunks.length !== currentLaps.length || chunksByLap.size !== chunks.length) {
        throw new Error("Downsample publication bundle lap set changed");
      }
      for (const lap of currentLaps) {
        const expected = expectedLaps.get(lap.id);
        const chunk = chunksByLap.get(lap.id);
        if (!expected || expected.captureChunkId !== lap.captureChunkId ||
            expected.sourceFrameStart !== lap.sourceFrameStart || expected.sourceFrameCount !== lap.sourceFrameCount ||
            !chunk || chunk.ownedFrameByteOffset === undefined || chunk.ownedFrameCount === undefined) {
          throw new Error("Downsample publication bundle lap references changed");
        }
        await tx.update(laps).set({
          captureChunkId: chunk.id, sourceFrameStart: null, sourceFrameCount: chunk.ownedFrameCount,
        }).where(eq(laps.id, lap.id));
      }
      await tx.update(sessions).set({
        captureLayoutVersion: 1, captureManifestFile: bundle.manifestPath, captureArchiveFile: null,
      }).where(eq(sessions.id, id));
    }
    await tx.delete(sessionCaptureSplitJobs).where(inArray(sessionCaptureSplitJobs.sessionId, checked.sessionIds));
    for (const id of checked.sessionIds) {
      await tx.update(sessions).set({
        rawFile: input.newRawFile,
        downsampledFrequencyHz: sql`CASE WHEN ${sessions.downsampledFrequencyHz} IS NULL OR ${sessions.downsampledFrequencyHz} > ${input.targetHz} THEN ${input.targetHz} ELSE ${sessions.downsampledFrequencyHz} END`,
      }).where(eq(sessions.id, id));
    }
    for (const index of input.lapIndexes) {
      await tx.update(laps).set({ rawByteOffset: index.rawByteOffset, rawFrameCount: index.rawFrameCount })
        .where(and(eq(laps.id, index.lapId), eq(laps.rawByteOffset, index.expectedRawByteOffset), eq(laps.rawFrameCount, index.expectedRawFrameCount)));
    }
    const ids = checked.lapRows.map(({ id }) => id);
    if (ids.length) {
      await tx.update(laps).set({ fuelPerLap: null, tyreWear: null }).where(inArray(laps.id, ids));
      await tx.delete(lapMetrics).where(inArray(lapMetrics.lapId, ids));
      await tx.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, ids));
      await tx.delete(compareAnalyses).where(or(inArray(compareAnalyses.lapAId, ids), inArray(compareAnalyses.lapBId, ids)));
    }
    for (const experimentId of new Set(checked.lapRows.flatMap((row) => row.experimentId === null ? [] : [row.experimentId]))) {
      await tx.delete(lineSpreadCache).where(eq(lineSpreadCache.experimentId, experimentId));
    }
    await tx.update(dashboardSummaryState).set({ captureDirty: 1, captureReady: 1 })
      .where(inArray(dashboardSummaryState.sessionId, checked.sessionIds));
  }));
}

export async function commitSessionDownsampleCap(input: {
  oldRawFile: string;
  sessionIds: number[];
  targetHz: RecordingFrequencyHz;
  lapIndexes: ReadonlyArray<DownsampleLapIndex>;
}): Promise<void> {
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    const checked = await validateDownsampleReferences(tx, input.oldRawFile, input.sessionIds, input.lapIndexes);
    for (const id of checked.sessionIds) {
      await tx.update(sessions).set({
        downsampledFrequencyHz: sql`CASE WHEN ${sessions.downsampledFrequencyHz} IS NULL OR ${sessions.downsampledFrequencyHz} > ${input.targetHz} THEN ${input.targetHz} ELSE ${sessions.downsampledFrequencyHz} END`,
      }).where(eq(sessions.id, id));
    }
  }));
}

export async function getLapsForSession(sessionId: number): Promise<Array<{
  id: number; lapNumber: number; lapTime: number; isValid: boolean; isFavorite: boolean;
  notes: string | null; tuneId: number | null; lapGuid: string | null;
  rawByteOffset: number | null; rawFrameCount: number | null;
  sourceFinishedAt: string | null;
  sectorTimes: number[] | null;
}>> {
  const rows = await readDb
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      isFavorite: laps.isFavorite,
      notes: laps.notes,
      tuneId: laps.tuneId,
      lapGuid: laps.lapGuid,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      sourceFinishedAt: laps.sourceFinishedAt,
      sectorTimes: laps.sectorTimes,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .orderBy(laps.lapNumber)
    .all();
  return rows.map(r => ({ ...r, isValid: Boolean(r.isValid), isFavorite: Boolean(r.isFavorite) }));
}

/** Update lap frame index and metadata after reprocessing. */

export async function updateLapRawIndex(
  lapId: number,
  rawByteOffset: number | null,
  rawFrameCount: number,
  lapTime: number,
  isValid: boolean,
  invalidReason: string | null,
  sectors: number[] | null,
  classification: LapClassification | null,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({
    rawByteOffset,
    rawFrameCount,
    lapTime,
    isValid,
    invalidReason,
    sectorTimes: sectors,
    classification,
    ...versionIdentity,
  }).where(eq(laps.id, lapId)));
  cacheDelete(lapId);
}

/** Reconcile lap rows atomically, preserving IDs and user-owned fields for matched laps. */
export async function replaceLapsForSession(
  sessionId: number,
  replacements: ReadonlyArray<{
    lapId: number | null;
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    isFavorite: boolean;
    rawByteOffset: number | null;
    rawFrameCount: number;
    tuneId: number | null;
    notes: string | null;
    invalidReason: string | null;
    sectors: number[] | null;
    classification: LapClassification | null;
    lapGuid?: string | null;
    captureChunkId?: string | null;
    sourceFrameStart?: number | null;
    sourceFrameCount?: number | null;
    sourceFinishedAt?: string | null;
    versionIdentity?: TelemetryVersionIdentity;
  }>,
  sessionIdentity?: { carId: string; trackId: string },
  options: { preserveOriginalSourceArtifacts?: boolean } = {},
): Promise<void> {
  const invalidatedIds = await withDatabaseWrite(() => db.transaction(async (tx) => {
    const matchedIds = new Set(replacements.flatMap(({ lapId }) => lapId === null ? [] : [lapId]));
    const rows = await tx.select({
      id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
    }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const identityChanged = rows.length !== replacements.length || replacements.some((replacement) => {
      const previous = replacement.lapId === null ? undefined : rows.find(({ id }) => id === replacement.lapId);
      return !previous || previous.lapNumber !== replacement.lapNumber ||
        previous.rawByteOffset !== replacement.rawByteOffset || previous.rawFrameCount !== replacement.rawFrameCount;
    });
    const ownershipChanged = Boolean(sessionIdentity) || identityChanged;
    const deleted = rows.map(({ id }) => id).filter((id) => !matchedIds.has(id));
    const invalidated = [...matchedIds];
    if (ownershipChanged) {
      // Keep immutable original windows available for later retries and exact GUID-based source lookup.
      if (!options.preserveOriginalSourceArtifacts) {
        await tx.delete(liveCaptureMembers).where(inArray(liveCaptureMembers.lapId, rows.map(({ id }) => id)));
        await tx.update(sessions).set({ captureLayoutVersion: null, captureManifestFile: null, captureArchiveFile: null }).where(eq(sessions.id, sessionId));
        await tx.update(laps).set({ captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null }).where(eq(laps.sessionId, sessionId));
      }
      await tx.update(sessionCaptureSplitJobs).set({
        jobId: randomUUID(), attemptId: sql`${sessionCaptureSplitJobs.attemptId} + 1`,
        status: "failed", sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`,
        errorCode: "stale-publication", errorMessage: "Lap ownership changed during reprocessing",
        stagingPath: null, updatedAt: new Date().toISOString(),
      }).where(and(eq(sessionCaptureSplitJobs.sessionId, sessionId), or(
        eq(sessionCaptureSplitJobs.status, "queued"), eq(sessionCaptureSplitJobs.status, "splitting"),
        eq(sessionCaptureSplitJobs.status, "verifying"), eq(sessionCaptureSplitJobs.status, "publishing"),
        eq(sessionCaptureSplitJobs.status, "ready"),
      )));
    }
    if (identityChanged && rows.length > 0) {
      await tx.update(lapGuidReconciliation).set({ status: "held_ambiguous" })
        .where(inArray(lapGuidReconciliation.lapId, rows.map(({ id }) => id)));
    }
    const invalidate = async (ids: readonly number[]) => {
      for (const id of ids) {
        await tx.delete(lapMetrics).where(eq(lapMetrics.lapId, id));
        await tx.delete(lapAnalyses).where(eq(lapAnalyses.lapId, id));
      }
      if (ids.length > 0) {
        await tx.delete(compareAnalyses).where(
          or(inArray(compareAnalyses.lapAId, ids), inArray(compareAnalyses.lapBId, ids)),
        );
      }
    };
    const affectedExperiments = await tx
      .selectDistinct({ experimentId: laps.experimentId })
      .from(laps)
      .where(and(eq(laps.sessionId, sessionId), isNotNull(laps.experimentId)))
      .all();
    for (const { experimentId } of affectedExperiments) {
      if (experimentId === null) continue;
      await tx.delete(lineSpreadCache).where(eq(lineSpreadCache.experimentId, experimentId));
    }
    await invalidate(rows.map(({ id }) => id));
    const sourceIdentity = replacements.some(({ lapGuid }) => lapGuid != null)
      ? await tx.select({
        originalActivityId: sessions.originalActivityId, ownerUserId: sessions.ownerUserId,
        sourceRevision: sessions.originalSourceRevision,
      }).from(sessions).where(eq(sessions.id, sessionId)).get()
      : null;
    const liveCapture = options.preserveOriginalSourceArtifacts
      ? await tx.select({ captureEpoch: liveCaptures.captureEpoch }).from(liveCaptures).where(eq(liveCaptures.sessionId, sessionId)).get()
      : null;
    const liveMemberByChunkId = new Map<string, { generation: number; lapGuid: string }>();
    if (liveCapture) {
      const members = await tx.select({ generation: liveCaptureMembers.generation, descriptor: liveCaptureMembers.descriptor })
        .from(liveCaptureMembers).where(eq(liveCaptureMembers.captureEpoch, liveCapture.captureEpoch)).all();
      for (const row of members) {
        const member: unknown = JSON.parse(row.descriptor);
        if (!member || typeof member !== "object") throw new Error("Live source member descriptor is invalid");
        const chunkId = "id" in member ? member.id : undefined;
        const lapGuid = "lapGuid" in member ? member.lapGuid : undefined;
        if (typeof chunkId !== "string" || typeof lapGuid !== "string") continue;
        if (liveMemberByChunkId.has(chunkId)) throw new Error(`Live source chunk ${chunkId} is duplicated`);
        liveMemberByChunkId.set(chunkId, { generation: row.generation, lapGuid: lapGuid.toLowerCase() });
      }
    }
    const relinkLiveMember = async (replacement: typeof replacements[number], lapId: number) => {
      if (!liveCapture || !replacement.captureChunkId || !replacement.lapGuid) return;
      const member = liveMemberByChunkId.get(replacement.captureChunkId);
      if (!member || member.lapGuid !== replacement.lapGuid.toLowerCase()) {
        throw new Error(`Live source chunk ${replacement.captureChunkId} does not match original lap GUID`);
      }
      await tx.update(liveCaptureMembers).set({ lapId })
        .where(and(eq(liveCaptureMembers.captureEpoch, liveCapture.captureEpoch), eq(liveCaptureMembers.generation, member.generation))).run();
    };
    const bindOriginalGuid = async (lapId: number, sourceGuid: string) => {
      const guid = sourceGuid.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(guid)) {
        throw new Error("Authoritative lap GUID is not canonical UUID");
      }
      if (!sourceIdentity?.originalActivityId || !sourceIdentity.sourceRevision) {
        throw new Error("Original lap GUID has no retained source identity");
      }
      const lap = await tx.select({ lapGuid: laps.lapGuid }).from(laps).where(eq(laps.id, lapId)).get();
      if (!lap) throw new Error("Lap row is missing");
      const duplicateLap = await tx.select({ id: laps.id }).from(laps)
        .where(and(sql`lower(${laps.lapGuid}) = ${guid}`, sql`${laps.id} <> ${lapId}`)).get();
      const duplicateMapping = await tx.select({ id: lapGuidReconciliation.lapId }).from(lapGuidReconciliation)
        .where(and(sql`lower(${lapGuidReconciliation.lapGuid}) = ${guid}`, sql`${lapGuidReconciliation.lapId} <> ${lapId}`)).get();
      if (duplicateLap || duplicateMapping) throw new Error("Lap GUID identity conflicts with another original lap");
      const mapping = await tx.select().from(lapGuidReconciliation).where(eq(lapGuidReconciliation.lapId, lapId)).get();
      if (mapping?.sourceGuid != null && mapping.sourceGuid.toLowerCase() !== guid) {
        throw new Error("Lap GUID provenance conflicts with existing source identity");
      }
      const existingGuid = mapping?.lapGuid ?? lap.lapGuid;
      if (existingGuid != null && existingGuid.toLowerCase() !== guid) {
        throw new Error("Lap GUID identity conflicts with existing original identity");
      }
      await tx.update(laps).set({ lapGuid: guid }).where(eq(laps.id, lapId)).run();
      await tx.insert(lapGuidReconciliation).values({ lapId, lapGuid: guid, sourceGuid: guid, status: "resolved" })
        .onConflictDoUpdate({
          target: lapGuidReconciliation.lapId,
          set: { lapGuid: guid, sourceGuid: guid, status: "resolved" },
        }).run();
      const identity = await tx.select().from(originalActivitySourceLaps)
        .where(eq(originalActivitySourceLaps.lapGuid, guid)).get();
      if (identity && (identity.ownerUserId !== sourceIdentity.ownerUserId ||
          (identity.originalActivityId !== null && identity.originalActivityId !== sourceIdentity.originalActivityId))) {
        throw new Error("Original lap belongs to another source or owner");
      }
      if (identity?.sourceRevision != null && identity.sourceRevision !== sourceIdentity.sourceRevision) {
        throw new Error("Original lap source revision conflicts with retained history");
      }
      if (!identity) {
        await tx.insert(originalActivitySourceLaps).values({
          lapGuid: guid, originalActivityId: sourceIdentity.originalActivityId,
          ownerUserId: sourceIdentity.ownerUserId, sourceRevision: sourceIdentity.sourceRevision,
        }).run();
      } else if (identity.originalActivityId === null || identity.sourceRevision === null) {
        await tx.update(originalActivitySourceLaps).set({
          originalActivityId: identity.originalActivityId ?? sourceIdentity.originalActivityId,
          sourceRevision: identity.sourceRevision ?? sourceIdentity.sourceRevision,
        }).where(eq(originalActivitySourceLaps.lapGuid, guid)).run();
      }
    };
    for (const id of deleted) await tx.delete(laps).where(eq(laps.id, id));
    for (const replacement of replacements) {
      const values = {
        lapNumber: replacement.lapNumber,
        lapTime: replacement.lapTime,
        isValid: replacement.isValid,
        rawByteOffset: replacement.rawByteOffset,
        rawFrameCount: replacement.rawFrameCount,
        invalidReason: replacement.invalidReason,
        sectorTimes: replacement.sectors,
        classification: replacement.classification,
        ...(replacement.captureChunkId !== undefined ? { captureChunkId: replacement.captureChunkId } : {}),
        ...(replacement.sourceFrameStart !== undefined ? { sourceFrameStart: replacement.sourceFrameStart } : {}),
        ...(replacement.sourceFrameCount !== undefined ? { sourceFrameCount: replacement.sourceFrameCount } : {}),
        ...(replacement.sourceFinishedAt == null ? {} : { sourceFinishedAt: replacement.sourceFinishedAt }),
        ...replacement.versionIdentity,
      };
      if (replacement.lapId !== null) {
        const previous = rows.find(({ id }) => id === replacement.lapId);
        if (!previous || previous.rawByteOffset !== replacement.rawByteOffset ||
            previous.rawFrameCount !== replacement.rawFrameCount) {
          await tx.update(laps).set({
            driverAttribution: "Unknown", driverAttributionStints: null,
            sourceClockDomain: null, sourceLapStartMs: null, sourceLapEndMs: null,
          }).where(eq(laps.id, replacement.lapId));
        }
        await tx.update(laps).set({ ...values, fuelPerLap: null, tyreWear: null }).where(eq(laps.id, replacement.lapId));
        if (replacement.lapGuid) {
          await bindOriginalGuid(replacement.lapId, replacement.lapGuid);
        }
        await relinkLiveMember(replacement, replacement.lapId);
      } else {
        const inserted = await tx.insert(laps).values({
          sessionId,
          ...values,
          isFavorite: replacement.isFavorite,
          tuneId: replacement.tuneId,
          notes: replacement.notes,
        }).returning({ id: laps.id }).get();
        if (replacement.lapGuid) {
          await bindOriginalGuid(inserted.id, replacement.lapGuid);
        } else {
          await tx.insert(lapGuidReconciliation).values({
            lapId: inserted.id,
            lapGuid: null,
            sourceGuid: null,
            status: "held_ambiguous",
          }).run();
        }
        invalidated.push(inserted.id);
        await relinkLiveMember(replacement, inserted.id);
      }
    }
    if (sessionIdentity) {
      await tx.update(sessions).set(sessionIdentity).where(eq(sessions.id, sessionId));
    }
    return { deleted, invalidated, ownershipChanged };
  }));
  for (const id of invalidatedIds.deleted) cacheDelete(id);
  for (const id of invalidatedIds.invalidated) cacheDelete(id);
  if (invalidatedIds.ownershipChanged) clearSessionCaptureCache();
}


