import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { client, db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import {
  prepareDashboardPublicationCandidate,
  publishDashboardSession,
} from "@raceiq/backend-core/db/dashboard-summary-queries";
import {
  markDashboardCaptureCheckpoint,
  processDashboardSession,
} from "@raceiq/backend-core/session-capture/dashboard-processor";
import { executeSessionCleanup } from "@raceiq/backend-core/session-capture/session-cleanup";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";

const sessionIds: number[] = [];
const capturePaths: string[] = [];

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId);
  for (const path of capturePaths.splice(0)) await rm(path, { force: true });
});

async function seedSession(rawFile: string | null = null): Promise<number> {
  const row = await db.insert(sessions).values({
    gameId: "acc", carId: "7", trackId: "8", carOrdinal: 7, trackOrdinal: 8,
    ownership: "mine", createdAt: "2026-06-01T12:00:00.000Z", sessionType: "race", rawFile,
  }).returning({ id: sessions.id }).get();
  sessionIds.push(row.id);
  return row.id;
}

type SqlExecutor = Pick<typeof client, "execute">;

async function rows(sql: string, args: (string | number | null)[] = [], executor: SqlExecutor = client) {
  return (await executor.execute({ sql, args })).rows;
}

async function state(sessionId: number, executor: SqlExecutor = client) {
  return (await rows("SELECT source_revision, published_revision, metadata_dirty, capture_dirty, capture_ready, deleted FROM dashboard_summary_state WHERE session_id=?", [sessionId], executor))[0] as Record<string, unknown>;
}

function unavailableEvidence(sourceRevision: number) {
  return {
    sourceRevision,
    captureRevision: "capture-test",
    duration: { status: "unavailable" as const, elapsedSeconds: null },
    sectorLayout: null,
    weather: { status: "unavailable" as const, revision: null, conditions: null },
    trackLengthMeters: null,
    sourceSectorStarts: null,
  };
}

test("direct source writes advance revision; transaction rollback rolls invalidation back", async () => {
  const sessionId = await seedSession();
  let current = await state(sessionId);
  expect(current).toMatchObject({ source_revision: 1, metadata_dirty: 1 });

  await client.execute({
    sql: "INSERT INTO laps(session_id,lap_number,lap_time,is_valid,created_at) VALUES(?,1,91,1,'2026-06-01T12:01:00.000Z')",
    args: [sessionId],
  });
  let changed = await state(sessionId);
  expect(Number(changed.source_revision)).toBeGreaterThan(Number(current.source_revision));
  expect(changed.metadata_dirty).toBe(1);
  current = changed;

  await client.execute({ sql: "UPDATE laps SET is_valid=0,sector_times='[30,31,30]' WHERE session_id=?", args: [sessionId] });
  changed = await state(sessionId);
  expect(Number(changed.source_revision)).toBeGreaterThan(Number(current.source_revision));
  current = changed;

  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "UPDATE laps SET lap_time=92 WHERE session_id=?", args: [sessionId] });
    expect(Number((await state(sessionId, tx)).source_revision)).toBeGreaterThan(Number(current.source_revision));
    await markDashboardCaptureCheckpoint(sessionId, false, tx);
    expect((await state(sessionId, tx)).capture_dirty).toBe(1);
    await tx.rollback();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  expect(await state(sessionId)).toMatchObject({
    source_revision: current.source_revision,
    capture_dirty: current.capture_dirty,
    capture_ready: current.capture_ready,
  });

  await client.execute({ sql: "DELETE FROM laps WHERE session_id=?", args: [sessionId] });
  changed = await state(sessionId);
  expect(Number(changed.source_revision)).toBeGreaterThan(Number(current.source_revision));
  expect(changed.metadata_dirty).toBe(1);
});

test("capture-only checkpoints invalidate all mine sessions sharing one raw path", async () => {
  const sharedPath = resolve(resolveDataDir(), "sessions", "acc", "dashboard-shared-capture-test.bin");
  const first = await seedSession(sharedPath);
  const second = await seedSession(sharedPath);
  const beforeFirst = await state(first);
  const beforeSecond = await state(second);

  await markDashboardCaptureCheckpoint(first, false);

  const afterFirst = await state(first);
  const afterSecond = await state(second);
  expect(Number(afterFirst.source_revision)).toBeGreaterThan(Number(beforeFirst.source_revision));
  expect(Number(afterSecond.source_revision)).toBeGreaterThan(Number(beforeSecond.source_revision));
  expect(afterFirst).toMatchObject({ capture_dirty: 1, capture_ready: 0 });
  expect(afterSecond).toMatchObject({ capture_dirty: 1, capture_ready: 0 });
});

test("stale capture candidate cannot republish after source revision changes or session deletion", async () => {
  const sessionId = await seedSession();
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  expect(candidate).not.toBeNull();
  await client.execute({ sql: "UPDATE sessions SET session_type='practice' WHERE id=?", args: [sessionId] });
  expect(await publishDashboardSession(candidate!, unavailableEvidence(candidate!.sourceRevision))).toBe(false);
  expect(await rows("SELECT session_id FROM dashboard_session_summaries WHERE session_id=?", [sessionId])).toHaveLength(0);

  const deletionCandidate = await prepareDashboardPublicationCandidate(sessionId);
  expect(deletionCandidate).not.toBeNull();
  await deleteSession(sessionId);
  expect(await publishDashboardSession(deletionCandidate!, unavailableEvidence(deletionCandidate!.sourceRevision))).toBe(false);
  expect(await rows("SELECT id FROM sessions WHERE id=?", [sessionId])).toHaveLength(0);
  expect(await rows("SELECT session_id FROM dashboard_session_summaries WHERE session_id=?", [sessionId])).toHaveLength(0);
  expect((await state(sessionId)).deleted).toBe(1);
});

test("cleanup removes shared raw bytes and republishes capture evidence unavailable", async () => {
  const rawFile = resolve(resolveDataDir(), "sessions", "acc", `dashboard-cleanup-${crypto.randomUUID()}.bin`);
  await mkdir(resolve(rawFile, ".."), { recursive: true });
  await Bun.write(rawFile, Buffer.from([1, 2, 3, 4]));
  capturePaths.push(rawFile);
  const sessionId = await seedSession(rawFile);
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  expect(candidate).not.toBeNull();
  expect(await publishDashboardSession(candidate!, unavailableEvidence(candidate!.sourceRevision))).toBe(true);

  const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
  expect(result.cleanedSessionIds).toContain(sessionId);
  expect(await Bun.file(rawFile).exists()).toBe(false);
  expect(await processDashboardSession(sessionId)).toBe(true);

  const summary = (await rows("SELECT capture_revision,duration_status,elapsed_seconds,weather_status,weather_conditions_json FROM dashboard_session_summaries WHERE session_id=?", [sessionId]))[0] as Record<string, unknown>;
  expect(summary).toMatchObject({ capture_revision: "missing", duration_status: "unavailable", elapsed_seconds: null, weather_status: "unavailable", weather_conditions_json: null });
});
