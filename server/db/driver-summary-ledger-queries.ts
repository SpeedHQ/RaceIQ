import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { db, readDb } from "./index";
import { driverSummaryActivities, driverSummaryActivityLaps, laps, localAccountOwner, originalActivityPreparations, originalActivitySources, sessions } from "./schema";
import { parseDriverSummaryPreparationSnapshot } from "../driver-summary/preparation";
import { withDatabaseWrite } from "./write-coordination";

export type DriverSummaryActivityState = "ready" | "held_ambiguous" | "conflict" | "synced";
export type LapDriverAttribution = "Self" | "Other" | "Mixed" | "Unknown";

export interface DriverSummaryActivityInput {
  activityId: string;
  ownerUserId: string | null;
  gameId: string;
  lapGuids: string[];
  payload: unknown;
  contentHash: string;
  expectedCloudRevision: number | null;
  state: DriverSummaryActivityState;
  heldReason: string | null;
}

export interface DriverSummaryPreparationFence {
  originalActivityGeneration: number;
  snapshotJson: string;
  holdReason: string | null;
}

/** Persist one immutable original identity, correcting its payload only under that same identity. */
export async function putDriverSummaryActivity(
  input: DriverSummaryActivityInput,
  preparation?: DriverSummaryPreparationFence,
): Promise<void> {
  const lapGuids = [...new Set(input.lapGuids)];
  if (!input.activityId || !input.gameId || !input.contentHash || lapGuids.some((guid) => !guid.trim()) || lapGuids.length !== input.lapGuids.length) {
    throw new Error("Driver summary activity identity is incomplete or contains duplicate lap GUIDs");
  }
  const payloadJson = JSON.stringify(input.payload);
  if (payloadJson === undefined) throw new Error("Driver summary activity payload is not JSON serializable");
  const lapGuidsJson = JSON.stringify(lapGuids);
  const snapshot = preparation ? parseDriverSummaryPreparationSnapshot(preparation.snapshotJson) : null;
  if (preparation && (!Number.isSafeInteger(preparation.originalActivityGeneration) || preparation.originalActivityGeneration < 1
    || !snapshot || (snapshot.contentHash !== null && snapshot.contentHash !== input.contentHash)
    || (preparation.holdReason === null && snapshot.contentHash !== input.contentHash))) {
    throw new TypeError("Driver summary preparation fence is invalid");
  }
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    if (preparation) {
      const generation = await tx.select().from(originalActivityPreparations)
        .where(eq(originalActivityPreparations.originalActivityId, input.activityId)).get();
      const source = await tx.select({ ownerUserId: originalActivitySources.ownerUserId }).from(originalActivitySources)
        .where(eq(originalActivitySources.originalActivityId, input.activityId)).get();
      const live = await tx.select({ id: sessions.id }).from(sessions).where(and(
        eq(sessions.originalActivityId, input.activityId), eq(sessions.ownership, "mine"),
        isNull(sessions.cloudImportOrigin), isNull(sessions.cloudImportLapId),
        input.ownerUserId === null ? isNull(sessions.ownerUserId) : eq(sessions.ownerUserId, input.ownerUserId),
      )).get();
      if (!generation || generation.generation !== preparation.originalActivityGeneration || !source || !live
        || source.ownerUserId !== input.ownerUserId) {
        throw Object.assign(new Error("Driver summary source changed during preparation"), { code: "stale_source" });
      }
    }
    const existing = await tx.select().from(driverSummaryActivities)
      .where(eq(driverSummaryActivities.activityId, input.activityId)).get();
    if (existing && (existing.ownerUserId !== input.ownerUserId || existing.gameId !== input.gameId)) {
      throw Object.assign(new Error("Driver summary activity identity cannot change owner or game"), { code: "activity_identity_conflict" });
    }
    if (preparation && existing && ((input.expectedCloudRevision ?? 0)
      < Math.max(existing.cloudRevision ?? 0, existing.heldCloudRevision ?? 0, existing.expectedCloudRevision ?? 0)
      || (input.expectedCloudRevision === null && existing.heldCloudRevision !== null))) {
      throw Object.assign(new Error("Cloud baseline changed during source preparation"), { code: "stale_source" });
    }
    const newLapGuids: string[] = [];
    for (const lapGuid of lapGuids) {
      const assigned = await tx.select({ lapGuid: driverSummaryActivityLaps.lapGuid, activityId: driverSummaryActivityLaps.activityId })
        .from(driverSummaryActivityLaps).where(eq(driverSummaryActivityLaps.lapGuid, lapGuid)).get();
      if (assigned && !(existing && assigned.activityId === input.activityId)) {
        throw Object.assign(new Error("Lap GUID already belongs to another summary activity"), { code: "activity_identity_conflict" });
      }
      if (!assigned) newLapGuids.push(lapGuid);
    }
    const updatedAt = new Date().toISOString();
    const heldReceipt = existing?.heldReceiptJson ? JSON.parse(existing.heldReceiptJson) as { contentHash: string } : null;
    const state = preparation && existing?.state === "conflict" ? "conflict"
      : preparation && heldReceipt?.contentHash === input.contentHash ? "held_ambiguous"
      : preparation && existing?.contentHash === input.contentHash && existing.state === "synced" && input.state === "ready" ? "synced"
      : input.state;
    const heldReason = preparation && (state === "conflict" || heldReceipt?.contentHash === input.contentHash)
      ? existing!.heldReason : input.heldReason;
    if (existing) {
      await tx.update(driverSummaryActivities).set({
        lapGuidsJson, payloadJson, contentHash: input.contentHash, expectedCloudRevision: input.expectedCloudRevision,
        state, heldReason, updatedAt,
      }).where(eq(driverSummaryActivities.activityId, input.activityId)).run();
    } else {
      await tx.insert(driverSummaryActivities).values({
        activityId: input.activityId, ownerUserId: input.ownerUserId, gameId: input.gameId,
        lapGuidsJson, payloadJson, contentHash: input.contentHash, expectedCloudRevision: input.expectedCloudRevision,
        cloudRevision: null, receiptJson: null, state: input.state, heldReason: input.heldReason, updatedAt,
      }).run();
    }
    // Keep historical GUID membership even when a correction contributes zero laps.
    if (newLapGuids.length) await tx.insert(driverSummaryActivityLaps).values(newLapGuids.map((lapGuid) => ({
      lapGuid, activityId: input.activityId, ownerUserId: input.ownerUserId,
    }))).run();
    if (preparation) {
      const settled = await tx.update(originalActivityPreparations).set({
        preparedGeneration: preparation.originalActivityGeneration,
        snapshotJson: preparation.holdReason === null ? preparation.snapshotJson
          : sql`COALESCE(${originalActivityPreparations.snapshotJson}, ${preparation.snapshotJson})`,
        holdReason: preparation.holdReason, heldLaps: snapshot!.heldLaps,
      }).where(and(eq(originalActivityPreparations.originalActivityId, input.activityId),
        eq(originalActivityPreparations.generation, preparation.originalActivityGeneration))).run();
      if (settled.rowsAffected !== 1) {
        throw Object.assign(new Error("Driver summary source changed during publication"), { code: "stale_source" });
      }
    }
  }));
}

/** The caller validates canonical hashes; this transaction binds that readback to immutable local ownership. */
export async function recordDriverSummaryActivityHold(input: {
  activityId: string; ownerUserId: string; receipt: { activityId: string; revision: number; contentHash: string };
  lapGuids: readonly string[]; observedContentHash: string; observedPayloadJson: string; holdReason: string | null;
}): Promise<void> {
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    const owner = await tx.select().from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
    const existing = await tx.select().from(driverSummaryActivities)
      .where(eq(driverSummaryActivities.activityId, input.activityId)).get();
    const original = await tx.select().from(originalActivitySources)
      .where(eq(originalActivitySources.originalActivityId, input.activityId)).get();
    if (!input.ownerUserId || owner?.onlineUserId !== input.ownerUserId || existing?.ownerUserId !== input.ownerUserId
      || original?.ownerUserId !== input.ownerUserId) {
      throw Object.assign(new Error("Held receipt owner does not match immutable original ownership"), { code: "activity_owner_conflict" });
    }
    if (existing.contentHash !== input.observedContentHash || existing.payloadJson !== input.observedPayloadJson) {
      throw Object.assign(new Error("Local contribution changed during held readback"), { code: "stale_source" });
    }
    const originalGuids = new Set(JSON.parse(original.originalLapGuidsJson) as string[]);
    if (input.lapGuids.some((guid) => !originalGuids.has(guid))) {
      throw Object.assign(new Error("Held receipt contains another original's GUID"), { code: "activity_identity_conflict" });
    }
    const minimumRevision = Math.max(existing.cloudRevision ?? 0, existing.heldCloudRevision ?? 0, existing.expectedCloudRevision ?? 0);
    const priorHeld = existing.heldReceiptJson ? JSON.parse(existing.heldReceiptJson) as { contentHash: string } : null;
    const priorConfirmed = existing.receiptJson ? JSON.parse(existing.receiptJson) as { contentHash: string } : null;
    if (input.receipt.revision < minimumRevision
      || (existing.heldCloudRevision === input.receipt.revision && priorHeld?.contentHash !== input.receipt.contentHash)
      || (existing.cloudRevision === input.receipt.revision && priorConfirmed?.contentHash !== input.receipt.contentHash)) {
      throw Object.assign(new Error("Held receipt violates the cloud revision baseline"), { code: "activity_revision_conflict" });
    }
    const sameBody = existing.contentHash === input.receipt.contentHash;
    // expectedRevision is transport metadata, not part of the immutable canonical body/hash.
    const payload = JSON.parse(existing.payloadJson) as { expectedRevision: number | null };
    payload.expectedRevision = input.receipt.revision;
    await tx.update(driverSummaryActivities).set({
      expectedCloudRevision: input.receipt.revision, payloadJson: JSON.stringify(payload),
      heldCloudRevision: input.receipt.revision, heldReceiptJson: JSON.stringify(input.receipt),
      state: sameBody ? "held_ambiguous" : "ready", heldReason: sameBody ? input.holdReason : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(driverSummaryActivities.activityId, input.activityId)).run();
  }));
}

/** Store authenticated confirmation without replacing a newer locally prepared canonical body. */
export async function recordDriverSummaryActivityConfirmation(input: {
  activityId: string; ownerUserId: string; gameId: string;
  receipt: { activityId: string; revision: number; contentHash: string };
  lapGuids: readonly string[]; observedContentHash: string; observedPayloadJson: string;
}): Promise<void> {
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    const owner = await tx.select().from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
    const existing = await tx.select().from(driverSummaryActivities)
      .where(eq(driverSummaryActivities.activityId, input.activityId)).get();
    const original = await tx.select().from(originalActivitySources)
      .where(eq(originalActivitySources.originalActivityId, input.activityId)).get();
    if (!input.ownerUserId || owner?.onlineUserId !== input.ownerUserId || existing?.ownerUserId !== input.ownerUserId) {
      throw Object.assign(new Error("Confirmed receipt owner does not match this installation"), { code: "activity_owner_conflict" });
    }
    if (!original || original.ownerUserId === null) {
      throw Object.assign(new Error("Confirmed receipt lacks an owned original footprint"), { code: "activity_identity_ambiguous" });
    }
    if (original.ownerUserId !== input.ownerUserId) {
      throw Object.assign(new Error("Confirmed receipt owner does not match immutable original ownership"), { code: "activity_owner_conflict" });
    }
    if (existing.gameId !== input.gameId || input.receipt.activityId !== input.activityId) {
      throw Object.assign(new Error("Confirmed receipt identifies another activity or game"), { code: "activity_identity_conflict" });
    }
    if (existing.contentHash !== input.observedContentHash || existing.payloadJson !== input.observedPayloadJson) {
      throw Object.assign(new Error("Local contribution changed during confirmed readback"), { code: "stale_source" });
    }
    const originalGuids = new Set(JSON.parse(original.originalLapGuidsJson) as string[]);
    if (input.lapGuids.some((guid) => !originalGuids.has(guid))) {
      throw Object.assign(new Error("Confirmed receipt contains another original's GUID"), { code: "activity_identity_conflict" });
    }
    const minimumRevision = Math.max(existing.cloudRevision ?? 0, existing.heldCloudRevision ?? 0, existing.expectedCloudRevision ?? 0);
    const priorConfirmed = existing.receiptJson ? JSON.parse(existing.receiptJson) as { contentHash: string } : null;
    const priorHeld = existing.heldReceiptJson ? JSON.parse(existing.heldReceiptJson) as { contentHash: string } : null;
    if (input.receipt.revision < minimumRevision
      || (existing.cloudRevision === input.receipt.revision && priorConfirmed?.contentHash !== input.receipt.contentHash)
      || (existing.heldCloudRevision === input.receipt.revision && priorHeld?.contentHash !== input.receipt.contentHash)) {
      throw Object.assign(new Error("Confirmed receipt violates the cloud revision baseline"), { code: "activity_revision_conflict" });
    }
    const sameBody = existing.contentHash === input.receipt.contentHash;
    const payload = JSON.parse(existing.payloadJson) as { expectedRevision: number | null };
    payload.expectedRevision = input.receipt.revision;
    await tx.update(driverSummaryActivities).set({
      expectedCloudRevision: input.receipt.revision, payloadJson: JSON.stringify(payload),
      cloudRevision: input.receipt.revision, receiptJson: JSON.stringify(input.receipt),
      heldCloudRevision: null, heldReceiptJson: null,
      state: sameBody ? "synced" : "ready", heldReason: null, updatedAt: new Date().toISOString(),
    }).where(eq(driverSummaryActivities.activityId, input.activityId)).run();
  }));
}


export async function listDriverSummaryActivities(ownerUserId: string | null, state?: DriverSummaryActivityState) {
  return readDb.select().from(driverSummaryActivities).where(state
    ? and(ownerUserId === null ? isNull(driverSummaryActivities.ownerUserId) : eq(driverSummaryActivities.ownerUserId, ownerUserId), eq(driverSummaryActivities.state, state))
    : ownerUserId === null ? isNull(driverSummaryActivities.ownerUserId) : eq(driverSummaryActivities.ownerUserId, ownerUserId))
    .orderBy(driverSummaryActivities.updatedAt, driverSummaryActivities.activityId).all();
}

export async function listReadyDriverSummaryActivityPage(ownerUserId: string | null, afterId: string | null, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Driver summary page size must be a positive integer");
  const pageSize = Math.min(limit, 256);
  const rows = await readDb.select().from(driverSummaryActivities).where(and(
    ownerUserId === null ? isNull(driverSummaryActivities.ownerUserId) : eq(driverSummaryActivities.ownerUserId, ownerUserId),
    eq(driverSummaryActivities.state, "ready"), afterId === null ? undefined : gt(driverSummaryActivities.activityId, afterId),
  )).orderBy(driverSummaryActivities.activityId).limit(pageSize + 1).all();
  const more = rows.length > pageSize;
  const items = more ? rows.slice(0, pageSize) : rows;
  return { items, nextCursor: more ? items[items.length - 1]!.activityId : null };
}

export async function getDriverSummaryActivity(activityId: string, ownerUserId: string | null) {
  return readDb.select().from(driverSummaryActivities).where(and(
    eq(driverSummaryActivities.activityId, activityId), ownerUserId === null ? isNull(driverSummaryActivities.ownerUserId) : eq(driverSummaryActivities.ownerUserId, ownerUserId),
  )).get();
}

export async function listDriverSummaryActivityLaps(ownerUserId: string | null) {
  return readDb.select().from(driverSummaryActivityLaps)
    .where(ownerUserId === null ? isNull(driverSummaryActivityLaps.ownerUserId) : eq(driverSummaryActivityLaps.ownerUserId, ownerUserId))
    .orderBy(driverSummaryActivityLaps.lapGuid).all();
}

export async function setDriverSummaryActivityState(
  activityId: string,
  ownerUserId: string | null,
  state: DriverSummaryActivityState,
  details: { cloudRevision?: number | null; receipt?: unknown; heldReason?: string | null },
  receiptFence?: { contentHash: string; payloadJson: string; revision: number },
): Promise<void> {
  const values: Partial<typeof driverSummaryActivities.$inferInsert> = { state, updatedAt: new Date().toISOString() };
  if (details.cloudRevision !== undefined) values.cloudRevision = details.cloudRevision;
  if (details.receipt !== undefined) values.receiptJson = JSON.stringify(details.receipt);
  if (details.heldReason !== undefined) values.heldReason = details.heldReason;
  if (state === "synced") { values.heldCloudRevision = null; values.heldReceiptJson = null; }
  const ownerFilter = ownerUserId === null ? isNull(driverSummaryActivities.ownerUserId) : eq(driverSummaryActivities.ownerUserId, ownerUserId);
  const result = await withDatabaseWrite(() => db.update(driverSummaryActivities).set(values).where(and(
    eq(driverSummaryActivities.activityId, activityId), ownerFilter,
    receiptFence ? and(eq(driverSummaryActivities.contentHash, receiptFence.contentHash),
      eq(driverSummaryActivities.payloadJson, receiptFence.payloadJson),
      sql`COALESCE(${driverSummaryActivities.cloudRevision},0)<=${receiptFence.revision}`,
      sql`COALESCE(${driverSummaryActivities.heldCloudRevision},0)<=${receiptFence.revision}`,
      sql`COALESCE(${driverSummaryActivities.expectedCloudRevision},0)<=${receiptFence.revision}`) : undefined,
  )).run());
  if (result.rowsAffected !== 1) throw Object.assign(new Error(receiptFence
    ? "Driver summary activity changed during receipt validation" : "Driver summary activity not found"),
    { code: receiptFence ? "activity_revision_conflict" : "not_found" });
}

export async function replaceSessionDriverAttributionStints(
  sessionId: number,
  stints: readonly DriverAttributionStint[],
): Promise<void> {
  await withDatabaseWrite(() => db.update(sessions).set({ driverAttributionStints: [...stints] }).where(eq(sessions.id, sessionId)).run());
}

export async function listSessionDriverAttributionStints(sessionId: number): Promise<DriverAttributionStint[]> {
  const row = await readDb.select({ stints: sessions.driverAttributionStints }).from(sessions).where(eq(sessions.id, sessionId)).get();
  return row?.stints ?? [];
}

export async function setLapDriverAttribution(
  lapId: number,
  stints: readonly DriverAttributionStint[],
  attribution: LapDriverAttribution,
  source: { domain: string; startMs: number; endMs: number },
): Promise<void> {
  if (!source.domain || !Number.isFinite(source.startMs) || !Number.isFinite(source.endMs) || source.endMs <= source.startMs) {
    throw new Error("Lap source-clock range is invalid");
  }
  await withDatabaseWrite(() => db.update(laps).set({
    driverAttributionStints: [...stints], driverAttribution: attribution,
    sourceClockDomain: source.domain, sourceLapStartMs: source.startMs, sourceLapEndMs: source.endMs,
  }).where(eq(laps.id, lapId)).run());
}

/** Preserve a known original identity; only capture code assigns a new original activity ID. */
export async function bindSessionOriginalActivityId(sessionId: number, originalActivityId: string): Promise<void> {
  if (!originalActivityId.trim()) throw new Error("Original activity identity is required");
  const result = await withDatabaseWrite(() => db.update(sessions).set({ originalActivityId })
    .where(and(
      eq(sessions.id, sessionId), sql`${sessions.originalActivityId} IS NULL`,
      sql`${sessions.cloudImportOrigin} IS NULL AND ${sessions.cloudImportLapId} IS NULL`,
    )).run());
  if (result.rowsAffected === 0) {
    const row = await readDb.select({ originalActivityId: sessions.originalActivityId }).from(sessions)
      .where(eq(sessions.id, sessionId)).get();
    if (!row) throw Object.assign(new Error("Session not found"), { code: "not_found" });
    if (row.originalActivityId !== originalActivityId) {
      throw Object.assign(new Error("Original activity identity cannot be reassigned"), { code: "activity_identity_conflict" });
    }
  }
}
