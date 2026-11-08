import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { experimentActions, experiments, experimentVersions, laps, sessions } from "@raceiq/backend-core/db/schema";
import { createExperiment } from "@raceiq/backend-core/db/experiment-queries";
import {
  createExperimentVersion,
  deleteTestSubtree,
  getExperimentVersion,
  setExperimentVersionNoteGuarded,
  setExperimentVersionNotesGuarded,
} from "@raceiq/backend-core/db/experiment-version-queries";
import { setLapExperimentExcluded } from "@raceiq/backend-core/db/experiment-lap-queries";
import { undoLastAction } from "@raceiq/backend-core/experiments/undo";

const ownedExperimentIds: number[] = [];
const ownedRaceSessionIds: number[] = [];
afterEach(async () => {
  for (const id of ownedExperimentIds.splice(0)) {
    await db.delete(laps).where(eq(laps.experimentId, id)).run();
    await db.delete(experimentActions).where(eq(experimentActions.experimentId, id)).run();
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, id)).run();
    await db.delete(experiments).where(eq(experiments.id, id)).run();
  }
  for (const id of ownedRaceSessionIds.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
});

async function ownedExperiment(name: string): Promise<number> {
  const id = await createExperiment({ gameId: "acc", name });
  ownedExperimentIds.push(id);
  return id;
}

describe("atomic guarded Setup Engineer mutations", () => {
  test("stale guarded notes do not modify version or append actions; successful notes undo", async () => {
    const sid = await ownedExperiment("atomic-note");
    const versionId = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    await db.update(experiments).set({ headVersionId: versionId }).where(eq(experiments.id, sid)).run();
    await db.update(experimentVersions).set({ notes: "old notes", driverComment: "old driver" }).where(eq(experimentVersions.id, versionId)).run();

    const stale = await setExperimentVersionNotesGuarded(versionId, "stale", sid, null, {
      kind: "edit-test-notes", inversePayload: { versionId },
    });
    expect(stale).toEqual({ ok: false, previous: null });
    expect((await getExperimentVersion(versionId))?.notes).toBe("old notes");
    expect(await db.select().from(experimentActions).where(eq(experimentActions.experimentId, sid)).all()).toHaveLength(0);

    const saved = await setExperimentVersionNotesGuarded(versionId, "new notes", sid, versionId, {
      kind: "edit-test-notes", inversePayload: { versionId },
    });
    expect(saved).toEqual({ ok: true, previous: "old notes" });
    expect((await undoLastAction(sid)).undone).toBe(true);
    expect((await getExperimentVersion(versionId))?.notes).toBe("old notes");

    const driverSave = await setExperimentVersionNoteGuarded(versionId, "new driver", sid, versionId, {
      kind: "edit-test-note", inversePayload: { versionId },
    });
    expect(driverSave).toEqual({ ok: true, previous: "old driver" });
    expect((await undoLastAction(sid)).undone).toBe(true);
    expect((await getExperimentVersion(versionId))?.driverComment).toBe("old driver");
  });

  test("guarded exclusion rejects stale head and null-head lap retagging without action rows", async () => {
    const sid = await ownedExperiment("atomic-exclusion");
    const sessionId = await db.insert(sessions).values({ gameId: "acc", carId: "1", trackId: "2" }).returning({ id: sessions.id }).get();
    ownedRaceSessionIds.push(sessionId!.id);
    const lapId = await db.insert(laps).values({ sessionId: sessionId!.id, lapNumber: 1, lapTime: 90000,
      experimentId: sid, experimentVersionId: null, experimentExcluded: 1, experimentExcludedSource: "auto" })
      .returning({ id: laps.id }).get();
    const stale = await setLapExperimentExcluded(lapId!.id, false, {
      sessionId: sid, expectedHeadVersionId: 12, allowedLapIds: [lapId!.id],
    }, { kind: "set-lap-excluded", inversePayload: { lapId: lapId!.id } });
    expect(stale.ok).toBe(false);
    expect(await db.select().from(experimentActions).where(eq(experimentActions.experimentId, sid)).all()).toHaveLength(0);
    await db.update(laps).set({ experimentVersionId: 12 }).where(eq(laps.id, lapId!.id)).run();
    const retagged = await setLapExperimentExcluded(lapId!.id, false, {
      sessionId: sid, expectedHeadVersionId: null, allowedLapIds: [lapId!.id],
    }, { kind: "set-lap-excluded", inversePayload: { lapId: lapId!.id } });
    expect(retagged.ok).toBe(false);
    const row = await db.select({ experimentExcluded: laps.experimentExcluded, source: laps.experimentExcludedSource })
      .from(laps).where(eq(laps.id, lapId!.id)).get();
    expect(row).toEqual({ experimentExcluded: 1, source: "auto" });
    await db.update(laps).set({ experimentVersionId: null }).where(eq(laps.id, lapId!.id)).run();
    const success = await setLapExperimentExcluded(lapId!.id, false, {
      sessionId: sid, expectedHeadVersionId: null, allowedLapIds: [lapId!.id],
    }, { kind: "set-lap-excluded", inversePayload: { lapId: lapId!.id } });
    expect(success).toMatchObject({ ok: true, prev: true, experimentId: sid });
    expect((await undoLastAction(sid)).undone).toBe(true);
    const restored = await db.select({ experimentExcluded: laps.experimentExcluded, source: laps.experimentExcludedSource })
      .from(laps).where(eq(laps.id, lapId!.id)).get();
    expect(restored).toEqual({ experimentExcluded: 1, source: "auto" });
  });
  test("guarded delete action records only actually deleted deep descendants", async () => {
    const sid = await ownedExperiment("atomic-delete");
    const root = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    const child = await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: root });
    const grandchild = await createExperimentVersion({ experimentId: sid, version: 3, label: "v3", parentVersionId: child });
    await db.update(experiments).set({ headVersionId: root }).where(eq(experiments.id, sid)).run();
    await db.update(experimentVersions).set({ status: "deleted" }).where(eq(experimentVersions.id, child)).run();
    const deleted = await deleteTestSubtree(sid, root, root, root, {
      kind: "delete", inversePayload: { rootTestId: root, prevHeadTestId: null, testIds: [root, child] },
    });
    expect(deleted.deletedIds).toEqual([root, grandchild]);
    const log = await db.select().from(experimentActions).where(and(eq(experimentActions.experimentId, sid), eq(experimentActions.kind, "delete"))).get();
    expect(JSON.parse(log!.inversePayload!)).toMatchObject({ testIds: [root, grandchild], prevHeadTestId: root });
    expect((await undoLastAction(sid)).undone).toBe(true);
    const statuses = await db.select({ id: experimentVersions.id, status: experimentVersions.status })
      .from(experimentVersions).where(eq(experimentVersions.experimentId, sid)).all();
    expect(statuses).toEqual([{ id: root, status: "active" }, { id: child, status: "deleted" }, { id: grandchild, status: "active" }]);
    expect((await db.select({ headVersionId: experiments.headVersionId }).from(experiments).where(eq(experiments.id, sid)).get())?.headVersionId).toBe(root);
  });
});
