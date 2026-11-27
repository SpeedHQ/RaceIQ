import { eq } from "drizzle-orm";
import { db, closeDb, initDb } from "@raceiq/backend-core/db/index";
import { lapMetrics, laps, sessionCaptureSplitJobs, sessions } from "@raceiq/backend-core/db/schema";

const [action, rawId, value, rawFrame] = process.argv.slice(2);
const id = Number(rawId);
if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Fixture mutation requires a positive safe session/lap ID");

await initDb();
try {
  if (action === "stale-insights") {
    const before = await db.select({ insightVersion: lapMetrics.insightVersion }).from(lapMetrics).where(eq(lapMetrics.lapId, id)).get();
    if (!before) throw new Error(`Missing lap metrics for fixture lap ${id}`);
    await db.update(lapMetrics).set({ insightVersion: 0, insights: "[]" }).where(eq(lapMetrics.lapId, id)).run();
    console.log(JSON.stringify(before));
  } else if (action === "invalid-source-indices") {
    const before = await db.select({ insights: lapMetrics.insights }).from(lapMetrics).where(eq(lapMetrics.lapId, id)).get();
    if (!before) throw new Error(`Missing lap metrics for fixture lap ${id}`);
    const insights = JSON.parse(before.insights) as Array<Record<string, unknown>>;
    const finding = insights.find((insight) => insight.id === "driving-brake-drag");
    if (!finding) throw new Error(`Missing brake-drag evidence for fixture lap ${id}`);
    await db.update(lapMetrics).set({
      insights: JSON.stringify([{ ...finding, frameIndices: [-1, 999999] }]),
    }).where(eq(lapMetrics.lapId, id)).run();
    console.log(JSON.stringify({ insights }));
  } else if (action === "set-source-frame") {
    const frame = Number(rawFrame);
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > 599) throw new Error(`Unsupported fixture source frame: ${rawFrame}`);
    const before = await db.select({ insightVersion: lapMetrics.insightVersion, insights: lapMetrics.insights }).from(lapMetrics).where(eq(lapMetrics.lapId, id)).get();
    if (!before) throw new Error(`Missing lap metrics for fixture lap ${id}`);
    const insights = JSON.parse(before.insights) as Array<Record<string, unknown>>;
    const finding = insights.find((insight) => insight.id === "driving-brake-drag");
    if (!finding) throw new Error(`Missing brake-drag evidence for fixture lap ${id}`);
    await db.update(lapMetrics).set({
      insights: JSON.stringify([{ ...finding, frameIndices: [frame] }]),
    }).where(eq(lapMetrics.lapId, id)).run();
    console.log(JSON.stringify({ insightVersion: before.insightVersion, finding }));
  } else if (action === "split-status") {
    const previous = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, id)).get();
    const status = value;
    if (status !== "splitting" && status !== "failed") throw new Error(`Unsupported fixture split status: ${status}`);
    if (previous) {
      await db.update(sessionCaptureSplitJobs).set({
        status,
        errorMessage: status === "failed" ? "Controlled test failure" : null,
      }).where(eq(sessionCaptureSplitJobs.sessionId, id)).run();
    } else {
      const session = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, id)).get();
      if (!session?.rawFile) throw new Error(`Missing raw recording for fixture session ${id}`);
      await db.insert(sessionCaptureSplitJobs).values({
        sessionId: id,
        jobId: `coaching-fixture-${id}`,
        pendingSourceRevision: "coaching-fixture",
        sourcePath: session.rawFile,
        status,
        errorMessage: status === "failed" ? "Controlled test failure" : null,
      }).run();
    }
    console.log(JSON.stringify(previous ?? null));
  } else if (action === "clear-session-capture") {
    const previous = await db.select({ captureManifestFile: sessions.captureManifestFile }).from(sessions).where(eq(sessions.id, id)).get();
    if (!previous) throw new Error(`Missing fixture session ${id}`);
    await db.update(sessions).set({ captureManifestFile: null }).where(eq(sessions.id, id)).run();
    console.log(JSON.stringify(previous.captureManifestFile));
  } else if (action === "restore-session-capture") {
    const captureManifestFile = value === undefined ? null : JSON.parse(value) as string | null;
    await db.update(sessions).set({ captureManifestFile }).where(eq(sessions.id, id)).run();
    console.log("restored");
  } else if (action === "delete-lap") {
    await db.delete(laps).where(eq(laps.id, id)).run();
    console.log("deleted");
  } else if (action === "restore-split-status") {
    if (value !== undefined && value !== "null") {
      const previous = JSON.parse(value) as typeof sessionCaptureSplitJobs.$inferInsert;
      await db.delete(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, id)).run();
      await db.insert(sessionCaptureSplitJobs).values(previous).run();
    } else {
      await db.delete(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, id)).run();
    }
    console.log("restored");
  } else if (action === "set-lap-state") {
    const previous = await db.select({
      isValid: laps.isValid,
      classification: laps.classification,
      experimentExcluded: laps.experimentExcluded,
    }).from(laps).where(eq(laps.id, id)).get();
    if (!previous) throw new Error(`Missing fixture lap ${id}`);
    const state = value;
    const change = state === "invalid"
      ? { isValid: false }
      : state === "valid"
        ? { isValid: true, classification: "pace" as const, experimentExcluded: 0 }
      : state === "non-pace"
        ? { classification: "out_lap" as const }
      : state === "excluded"
        ? { experimentExcluded: 1 }
        : null;
    if (!change) throw new Error(`Unsupported fixture lap state: ${state}`);
    await db.update(laps).set(change).where(eq(laps.id, id)).run();
    console.log(JSON.stringify(previous));
  } else if (action === "restore-lap-state") {
    const previous = JSON.parse(value ?? "null") as Pick<typeof laps.$inferSelect, "isValid" | "classification" | "experimentExcluded">;
    if (!previous) throw new Error("Missing previous fixture lap state");
    await db.update(laps).set(previous).where(eq(laps.id, id)).run();
    console.log("restored");
  } else if (action === "replace-session-capture") {
    const previous = await db.select({ captureManifestFile: sessions.captureManifestFile }).from(sessions).where(eq(sessions.id, id)).get();
    if (!previous) throw new Error(`Missing fixture session ${id}`);
    await db.update(sessions).set({ captureManifestFile: value ?? null }).where(eq(sessions.id, id)).run();
    console.log(JSON.stringify(previous.captureManifestFile));
  } else {
    throw new Error(`Unknown fixture mutation: ${action}`);
  }
} finally {
  closeDb();
}
