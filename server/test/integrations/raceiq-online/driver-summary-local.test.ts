import { expect, test } from "bun:test";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { client } from "../../../db";
import { deleteSession, insertSession } from "../../../db/session-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import { setLapDriverAttribution } from "../../../db/driver-summary-ledger-queries";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "../../../db/dashboard-summary-queries";
import { getDashboard } from "../../../db/dashboard-queries";
import { buildLocalDriverSummary } from "../../../driver-summary";

function stints(attribution: "Self" | "Other" | "Mixed" | "Unknown"): DriverAttributionStint[] {
  const segment = (value: "Self" | "Other", startMs: number, endMs: number): DriverAttributionStint => ({
    gameId: "acc", source: "native", sessionId: "local-metrics-test", startMs, endMs,
    evidenceValidUntilMs: endMs, clockDomain: "local-metrics-test", attribution: value, bindingRevision: 1,
    actor: { gameId: "acc", source: "native", actorId: value.toLowerCase(), bindingScope: "installation",
      sessionId: "local-metrics-test", clockDomain: "local-metrics-test", observedAtMs: startMs },
  });
  if (attribution === "Mixed") return [segment("Self", 0, 50), segment("Other", 50, 100)];
  if (attribution === "Unknown") return [];
  return [segment(attribution, 0, 100)];
}

test("offline local summary and dashboard preserve Self-only metrics and non-personal attribution context", async () => {
  const sessionId = await insertSession("local-metrics-car", "local-metrics-track", "acc", "race");
  const borrowedId = await insertSession("borrowed-metrics-car", "borrowed-metrics-track", "acc", "race", undefined, "others");
  const request = { from: "2025-05-12T12:00:00.000Z", to: "2025-05-12T12:10:00.000Z", gameId: "acc" as const };
  try {
    for (const id of [sessionId, borrowedId]) {
      await client.execute({ sql: "UPDATE sessions SET created_at='2025-05-12 12:01:00' WHERE id=?", args: [id] });
    }
    for (const [index, attribution] of (["Self", "Other", "Mixed", "Unknown"] as const).entries()) {
      const lapId = await insertLap(sessionId, index + 1, 60 + index * 10, true, null, 0);
      await client.execute({ sql: "UPDATE laps SET created_at='2025-05-12 12:02:00' WHERE id=?", args: [lapId] });
      await setLapDriverAttribution(lapId, stints(attribution), attribution, {
        domain: "local-metrics-test", startMs: 10, endMs: 90,
      });
    }
    const borrowedLap = await insertLap(borrowedId, 1, 500, true, null, 0);
    await client.execute({ sql: "UPDATE laps SET created_at='2025-05-12 12:02:00' WHERE id=?", args: [borrowedLap] });
    await setLapDriverAttribution(borrowedLap, stints("Self"), "Self", {
      domain: "local-metrics-test", startMs: 10, endMs: 90,
    });
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate) throw new Error("Missing local metrics fixture candidate");
    await publishDashboardSession(candidate);

    const summary = await buildLocalDriverSummary(request);
    expect(summary.summary.metrics).toMatchObject({ laps: 1, positiveLaps: 1, validLaps: 1, drivenSeconds: 60, validSeconds: 60 });
    expect(summary.context).toEqual({ basis: "positive_lap_time",
      other: { laps: 1, seconds: 70 }, mixed: { laps: 1, seconds: 80 }, unknown: { laps: 1, seconds: 90 } });
    expect((await getDashboard(request)).totals).toMatchObject({ laps: 1, positiveLaps: 1, drivenSeconds: 60, validSeconds: 60 });
  } finally {
    await deleteSession(sessionId);
    await deleteSession(borrowedId);
  }
});
