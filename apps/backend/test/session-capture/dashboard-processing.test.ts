import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initServerGameAdapters } from "../../src/games/init";
import { client, db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import {
  markDashboardCaptureCheckpoint,
  processDashboardSession,
} from "@raceiq/backend-core/session-capture/dashboard-processor";
import {
  prepareDashboardPublicationCandidate,
  publishDashboardSession,
} from "@raceiq/backend-core/db/dashboard-summary-queries";

const fixture = resolve(import.meta.dir, "../../../../test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz");
const sessionIds: number[] = [];
const tempDirs: string[] = [];

beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId);
  for (const path of tempDirs.splice(0)) await rm(path, { recursive: true, force: true });
});


async function seedSession(rawFile = fixture): Promise<number> {
  const row = await db.insert(sessions).values({
    gameId: "acc", carId: "7", trackId: "8", carOrdinal: 7, trackOrdinal: 8,
    ownership: "mine", createdAt: "2026-04-23T16:42:16.158Z", sessionType: "practice", rawFile,
  }).returning({ id: sessions.id }).get();
  sessionIds.push(row.id);
  return row.id;
}

async function readSession(sessionId: number) {
  const result = await client.execute({
    sql: `SELECT st.source_revision, st.published_revision, st.capture_dirty, st.capture_ready, st.metadata_dirty,
      p.capture_revision, p.duration_status, p.elapsed_seconds, p.sector_layout_key, p.sector_count, p.sector_status,
      p.source_sector_starts_json, p.weather_status, p.weather_conditions_json
      FROM dashboard_summary_state st LEFT JOIN dashboard_session_summaries p ON p.session_id=st.session_id
      WHERE st.session_id=?`,
    args: [sessionId],
  });
  return result.rows[0] as Record<string, unknown>;
}

test("active checkpoint publishes metadata first; finalized capture facts publish once", async () => {
  const sessionId = await seedSession();
  await markDashboardCaptureCheckpoint(sessionId, false);
  const staleCandidate = await prepareDashboardPublicationCandidate(sessionId);
  expect(staleCandidate).not.toBeNull();
  expect(await processDashboardSession(sessionId)).toBe(true);
  let row = await readSession(sessionId);
  expect(row).toMatchObject({ capture_dirty: 1, capture_ready: 0, metadata_dirty: 0 });
  expect(row.capture_revision).toBeNull();

  const activeRevision = Number(row.source_revision);
  await markDashboardCaptureCheckpoint(sessionId, true);
  row = await readSession(sessionId);
  expect(Number(row.source_revision)).toBeGreaterThan(activeRevision);
  expect(row.capture_ready).toBe(1);
  expect(await processDashboardSession(sessionId)).toBe(true);

  row = await readSession(sessionId);
  expect(row).toMatchObject({ capture_dirty: 0, capture_ready: 1, metadata_dirty: 0 });
  expect(Number(row.published_revision)).toBe(Number(row.source_revision));
  if (row.duration_status === "available") expect(Number(row.elapsed_seconds)).toBeGreaterThan(0);
  else expect(row.elapsed_seconds).toBeNull();
  const sectorStatus = row.sector_status;
  if (typeof sectorStatus !== "string") throw new Error("Expected dashboard sector_status after capture publication");
  expect(["available", "unavailable"]).toContain(sectorStatus);
  const weatherStatus = row.weather_status;
  if (typeof weatherStatus !== "string") throw new Error("Expected dashboard weather_status after capture publication");
  expect(["available", "unavailable"]).toContain(weatherStatus);
  if (weatherStatus === "available") {
    const conditionsJson = row.weather_conditions_json;
    if (typeof conditionsJson !== "string") throw new Error("Expected weather_conditions_json when weather is available");
    expect(JSON.parse(conditionsJson)).toHaveProperty("frames");
  }
  const captureRevision = row.capture_revision;
  expect(await publishDashboardSession(staleCandidate!, {
    sourceRevision: staleCandidate!.sourceRevision,
    captureRevision: "stale-candidate",
    duration: { status: "unavailable", elapsedSeconds: null },
    sectorLayout: null,
    weather: { status: "unavailable", revision: null, conditions: null },
    trackLengthMeters: null,
    sourceSectorStarts: null,
  })).toBe(false);
  expect((await readSession(sessionId)).capture_revision).toBe(captureRevision);
  if (row.sector_layout_key !== null) {
    const startsJson = row.source_sector_starts_json;
    if (typeof startsJson !== "string") throw new Error("Expected source_sector_starts_json when sector layout is available");
    const starts: unknown = JSON.parse(startsJson);
    expect(Array.isArray(starts)).toBe(true);
    if (Array.isArray(starts)) expect(starts.length).toBe(Number(row.sector_count));
  }
});
test("capture identity depends on source content, not lossless gzip representation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-dashboard-capture-"));
  tempDirs.push(directory);
  const compressedPath = join(directory, "capture.bin.gz");
  const rawPath = join(directory, "capture.bin");
  const compressedBytes = await readFile(fixture);
  await writeFile(compressedPath, compressedBytes);
  await writeFile(rawPath, gunzipSync(compressedBytes));

  const compressedSessionId = await seedSession(compressedPath);
  const rawSessionId = await seedSession(rawPath);
  for (const sessionId of [compressedSessionId, rawSessionId]) {
    await markDashboardCaptureCheckpoint(sessionId, true);
    expect(await processDashboardSession(sessionId)).toBe(true);
  }
  expect((await readSession(compressedSessionId)).capture_revision).toBe(
    (await readSession(rawSessionId)).capture_revision,
  );
});
