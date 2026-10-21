import { and, eq, sql } from "drizzle-orm";
import type { GameIdentityBinding } from "@raceiq/online/contracts";
import { db } from "./index";
import { driverSummaryActivities, driverSummaryActivityLaps, localAccountOwner, localGameBindings, sessions } from "./schema";

export async function getLocalAccountOwner(): Promise<string | null> {
  const owner = await db.select({ onlineUserId: localAccountOwner.onlineUserId })
    .from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
  return owner?.onlineUserId ?? null;
}

/** First verified account claims unassigned owned local records once; later accounts cannot take them. */
export async function claimLocalAccountOwner(onlineUserId:string,guard?:{isCurrent():boolean}):Promise<void> {
  const userId = onlineUserId.trim();
  if (!userId) throw new Error("Online account identity is required");
  const assertCurrent=()=>{if(guard&&!guard.isCurrent())throw Object.assign(new Error("Account claim is no longer current"),{code:"stale_state"});};
  assertCurrent();
  await db.transaction(async (tx) => {
    assertCurrent();
    await tx.insert(localAccountOwner).values({ id: 1, onlineUserId: null }).onConflictDoNothing().run();
    const owner = await tx.select().from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
    if (!owner) throw new Error("Local account owner state is not initialized");
    if (owner.onlineUserId !== null && owner.onlineUserId !== userId) {
      throw Object.assign(new Error("Local installation is already bound to another Online account"), { code: "account_conflict" });
    }
    if (owner.onlineUserId === null) {
      assertCurrent();
      const claimed = await tx.update(localAccountOwner).set({ onlineUserId: userId })
        .where(and(eq(localAccountOwner.id, 1), sql`${localAccountOwner.onlineUserId} IS NULL`)).run();
      if (claimed.rowsAffected !== 1) {
        const current = await tx.select({ onlineUserId: localAccountOwner.onlineUserId })
          .from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
        if (current?.onlineUserId !== userId) {
          throw Object.assign(new Error("Local installation owner changed during account claim"), { code: "account_conflict" });
        }
      }
      assertCurrent();
      await tx.update(sessions).set({ ownerUserId: userId }).where(sql`
        ${sessions.ownerUserId} IS NULL AND ${sessions.ownership} = 'mine'
        AND ${sessions.cloudImportOrigin} IS NULL AND ${sessions.cloudImportLapId} IS NULL
      `).run();
      assertCurrent();
      await tx.update(driverSummaryActivities).set({ ownerUserId: userId }).where(sql`
        ${driverSummaryActivities.ownerUserId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM driver_summary_activity_laps contribution_lap
          LEFT JOIN laps ON laps.lap_guid = contribution_lap.lap_guid
          LEFT JOIN sessions ON sessions.id = laps.session_id
          WHERE contribution_lap.activity_id = ${driverSummaryActivities.activityId}
            AND sessions.id IS NOT NULL
            AND (sessions.ownership <> 'mine' OR sessions.cloud_import_origin IS NOT NULL
              OR sessions.cloud_import_lap_id IS NOT NULL
              OR (sessions.owner_user_id IS NOT NULL AND sessions.owner_user_id <> ${userId}))
        )
      `).run();
      assertCurrent();
      await tx.update(driverSummaryActivityLaps).set({ ownerUserId: userId }).where(sql`
        ${driverSummaryActivityLaps.ownerUserId} IS NULL
        AND ${driverSummaryActivityLaps.activityId} IN (
          SELECT activity_id FROM driver_summary_activities WHERE owner_user_id = ${userId}
        )
      `).run();
    }
    // Process queued cancellation before the final synchronous guard and commit.
    if(guard)await Bun.sleep(0);
    assertCurrent();
  });
}

export async function listLocalGameBindings(): Promise<GameIdentityBinding[]> {
  return db.select({
    id: localGameBindings.id,
    gameId: localGameBindings.gameId,
    sourceKind: localGameBindings.sourceKind,
    nativeIdentity: localGameBindings.nativeIdentity,
    confirmation: localGameBindings.confirmation,
    revision: localGameBindings.revision,
  }).from(localGameBindings).orderBy(localGameBindings.gameId).all();
}

export async function getLocalGameBindingSnapshot(): Promise<{ revision: number; bindings: GameIdentityBinding[] }> {
  return db.transaction(async (tx) => {
    const owner = await tx.select({ revision: localAccountOwner.bindingRevision })
      .from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
    const bindings = await tx.select({
      id: localGameBindings.id,
      gameId: localGameBindings.gameId,
      sourceKind: localGameBindings.sourceKind,
      nativeIdentity: localGameBindings.nativeIdentity,
      confirmation: localGameBindings.confirmation,
      revision: localGameBindings.revision,
    }).from(localGameBindings).orderBy(localGameBindings.gameId).all();
    return { revision: owner?.revision ?? 0, bindings };
  });
}

export interface GameBindingMutationGuard {expectedSnapshotRevision:number;isCurrent():boolean}
/** Binding revisions are monotonic per game; each committed mutation advances the global snapshot revision atomically. */
export async function upsertLocalGameBinding(binding: GameIdentityBinding,guard?:GameBindingMutationGuard): Promise<void> {
  if (!binding.id || !binding.gameId || !binding.sourceKind || !binding.nativeIdentity
    || !Number.isSafeInteger(binding.revision) || binding.revision <= 0
    || (binding.confirmation !== "native_verified" && binding.confirmation !== "user_confirmed")) {
    throw new Error("Game binding identity or revision is invalid");
  }
  await db.transaction(async (tx) => {
    await tx.insert(localAccountOwner).values({ id: 1, onlineUserId: null }).onConflictDoNothing().run();
    const owner = await tx.select().from(localAccountOwner).where(eq(localAccountOwner.id, 1)).get();
    if (!owner) throw new Error("Local account owner state is not initialized");
    if(guard&&(owner.bindingRevision!==guard.expectedSnapshotRevision||!guard.isCurrent()))throw Object.assign(new Error("Game binding candidate is stale"),{code:"stale_state"});
    const existing = await tx.select({ revision: localGameBindings.revision }).from(localGameBindings)
      .where(eq(localGameBindings.gameId, binding.gameId)).get();
    if (existing && binding.revision <= existing.revision) {
      throw Object.assign(new Error("Game binding revision must advance"), { code: "stale_state" });
    }
    const nextRevision = owner.bindingRevision + 1;
    const changed = await tx.update(localAccountOwner).set({ bindingRevision: nextRevision })
      .where(and(eq(localAccountOwner.id, 1), eq(localAccountOwner.bindingRevision, owner.bindingRevision))).run();
    if (changed.rowsAffected !== 1) throw Object.assign(new Error("Game binding snapshot changed"), { code: "stale_state" });
    await tx.insert(localGameBindings).values({ ...binding, updatedAt: new Date().toISOString() }).onConflictDoUpdate({
      target: localGameBindings.gameId,
      set: {
        id: binding.id,
        sourceKind: binding.sourceKind,
        nativeIdentity: binding.nativeIdentity,
        confirmation: binding.confirmation,
        revision: binding.revision,
        updatedAt: new Date().toISOString(),
      },
    }).run();
    if(guard&&!guard.isCurrent())throw Object.assign(new Error("Game binding candidate is stale"),{code:"stale_state"});
  });
}
