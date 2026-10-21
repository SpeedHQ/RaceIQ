import { expect, test } from "bun:test";
import { hashActivityContribution } from "@speedhq/live-client";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { client } from "@raceiq/backend-core/db/index";
import { claimLocalAccountOwner } from "@raceiq/backend-core/db/local-account-queries";
import { deleteSession, insertSession } from "@raceiq/backend-core/db/session-queries";
import { closeNativeOriginalActivitySource, finalizeNativeOriginalActivitySource } from "@raceiq/backend-core/db/original-activity-queries";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { getDashboard } from "@raceiq/backend-core/db/dashboard-queries";
import { buildLocalDriverSummary, hasPendingDriverSummaryPreparations, prepareDriverSummaryContributions,
  type DriverSummaryActivityContribution, type PreparedDriverSummaryContribution } from "@raceiq/backend-core/driver-summary/index";
import { DashboardCaptureObservation } from "@raceiq/backend-core/session-capture/dashboard-observation";

test("actual personal duration query includes a closed Self session with no completed lap and preserves Unknown session type", async () => {
  initGameAdapters();
  initServerGameAdapters();
  await claimLocalAccountOwner("owner-a");
  const sessionId = await insertSession("empty-car", "empty-track", "acc", "unclassified-native", undefined, "mine", { kind: "native_capture" });
  const request = { from: "2025-05-14T00:00:00.000Z", to: "2025-05-15T00:00:00.000Z", gameId: "acc" as const };
  let activityId = "";
  try {
    await client.execute({ sql: "UPDATE sessions SET created_at='2025-05-14 12:00:00' WHERE id=?", args: [sessionId] });
    await closeNativeOriginalActivitySource(sessionId, { sourceRevision: crypto.randomUUID(), lapCount: 0, gapCount: 0 });
    await finalizeNativeOriginalActivitySource(sessionId);
    activityId = String((await client.execute({ sql: "SELECT original_activity_id FROM sessions WHERE id=?", args: [sessionId] })).rows[0]!.original_activity_id);
    const observer = new DashboardCaptureObservation("acc", null);
    const packet = { gameId: "acc", CurrentRaceTime: 0, TimestampMS: 0 } as TelemetryPacket;
    const stints: DriverAttributionStint[] = [{
      gameId: "acc", source: "native", sessionId: "captured-session", startMs: 0, endMs: 100,
      evidenceValidUntilMs: 100, clockDomain: "source-clock", attribution: "Self", bindingRevision: 1,
      actor: { gameId: "acc", source: "native", actorId: "self", bindingScope: "installation",
        sessionId: "captured-session", clockDomain: "source-clock", observedAtMs: 0 },
    }];
    observer.observe(packet, undefined, 1_000, { sessionId: "captured-session", clockDomain: "source-clock", sourceTimeMs: 10, stints });
    observer.observe(packet, undefined, 13_000, { sessionId: "captured-session", clockDomain: "source-clock", sourceTimeMs: 90, stints });
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate) throw new Error("Missing duration fixture candidate");
    await publishDashboardSession(candidate, { ...observer.toFacts(), sourceRevision: candidate.sourceRevision });
    const local = await buildLocalDriverSummary(request);
    expect(local.summary.metrics).toMatchObject({ laps: 0, drivenSeconds: 0, sessionsWithDuration: 1, sessionsWithoutDuration: 0,
      sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 12 } });
    expect(local.coverage).toMatchObject({ identity: "complete", sessionDuration: "complete" });
    const dashboard = await getDashboard(request);
    expect(dashboard.totals).toMatchObject({ laps: 0, drivenSeconds: 0 });
    expect(dashboard.sessionTypes).toMatchObject({ totalSeconds: 12, unknownSeconds: 12,
      sessionsWithDuration: 1, sessionsWithoutDuration: 0, durationCoverage: "complete" });
    const contributions: PreparedDriverSummaryContribution[] = [];
    do {
      contributions.push(...await prepareDriverSummaryContributions(hashActivityContribution));
    } while (await hasPendingDriverSummaryPreparations());
    const prepared = contributions.find((item) => item.activityId === activityId);
    expect(prepared).toMatchObject({ lapGuids: [], state: "ready" });
    expect((prepared!.payload as DriverSummaryActivityContribution).metrics.sessionTypeSeconds.unknown).toBe(12);
  } finally {
    await deleteSession(sessionId);
    if (activityId) {
      await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id=?", args: [activityId] });
      await client.execute({ sql: "DELETE FROM original_activity_source_laps WHERE original_activity_id=?", args: [activityId] });
      await client.execute({ sql: "DELETE FROM original_activity_sources WHERE original_activity_id=?", args: [activityId] });
    }
  }
});
