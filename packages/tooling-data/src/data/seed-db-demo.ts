import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps, tunes, tuneAssignments, experiments, experimentVersions, experimentFocusEvents, lapAnalyses, compareAnalyses } from "@raceiq/backend-core/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { setLapDriverAttribution } from "@raceiq/backend-core/db/driver-summary-ledger-queries";
import { chatThreadId, compareChatThreadId, saveChatMessages } from "@raceiq/backend-core/ai/chat-agent";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { SEED_MARKER } from "./seed-db-options";

export function markOnboardingComplete(): void {
  saveSettings({ ...loadSettings(), onboardingComplete: true });
}

/** Demo evidence is local-only: never assign native origin, an account owner, or original activity identity. */
export async function repairDemoDashboardAttribution(): Promise<number> {
  const seeded = await db.select().from(sessions).where(eq(sessions.notes, SEED_MARKER)).all();
  let repaired = 0;
  for (const session of seeded) {
    if (session.ownership !== "mine" || session.nativeCaptureOrigin || session.originalActivityId
      || session.ownerUserId || session.cloudImportOrigin || session.cloudImportLapId != null) continue;
    const gameId = GameIdSchema.parse(session.gameId);
    const sessionLaps = await db.select().from(laps).where(eq(laps.sessionId, session.id)).all();
    for (const lap of sessionLaps) {
      if (lap.driverAttributionStints?.length || lap.sourceClockDomain
        || (lap.driverAttribution != null && lap.driverAttribution !== "Unknown")
        || !Number.isFinite(lap.lapTime) || lap.lapTime <= 0) continue;
      const source = SEED_MARKER;
      const sessionId = `demo-session:${session.id}`;
      const domain = `demo-lap:${lap.id}`;
      const endMs = lap.lapTime * 1000;
      const evidence: DriverAttributionStint = {
        gameId, source, sessionId, clockDomain: domain,
        startMs: 0, endMs, evidenceValidUntilMs: endMs, attribution: "Self", bindingRevision: 1,
        actor: { gameId, source, sessionId, clockDomain: domain,
          actorId: "demo-driver", bindingScope: "session", observedAtMs: 0 },
      };
      await setLapDriverAttribution(lap.id, [evidence], "Self", { domain, startMs: 0, endMs });
      repaired++;
    }
    const candidate = await prepareDashboardPublicationCandidate(session.id);
    if (candidate?.metadataDirty) await publishDashboardSession(candidate, undefined, { metadataOnly: true });
  }
  return repaired;
}

export async function insertDemoRows(profileId: number, importedLapIds: number[]): Promise<void> {
  const importedLaps = await db.select({ id: laps.id, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId })
    .from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(inArray(laps.id, importedLapIds)).all();
  await db.update(laps).set({ profileId }).where(inArray(laps.id, importedLapIds)).run();

  const fmLaps = importedLaps.filter((lap) => lap.gameId === "fm-2023");
  const fm = fmLaps[0];
  if (fm) {
    const tuneA = await db.insert(tunes).values({
      gameId: "fm-2023", name: "Demo Sprint Baseline", author: "RaceIQ Demo", carId: fm.carId,
      category: "road", trackId: fm.trackId, description: `Seeded demo tune (${SEED_MARKER})`,
      strengths: JSON.stringify(["Stable braking"]), weaknesses: JSON.stringify(["Corner exit traction"]),
      bestTracks: JSON.stringify(["Silverstone"]), strategies: JSON.stringify(["Brake earlier for consistency"]),
      settings: JSON.stringify({ frontArb: 32, rearArb: 28 }), unitSystem: "metric", source: SEED_MARKER,
    }).returning({ id: tunes.id }).get();
    await db.insert(tuneAssignments).values({ gameId: "fm-2023", carId: fm.carId, trackId: fm.trackId, tuneId: tuneA.id }).run();
    if (fmLaps.some((lap) => lap.carId !== fm.carId)) {
      const secondCar = fmLaps.find((lap) => lap.carId !== fm.carId)!.carId;
      const tuneB = await db.insert(tunes).values({
        gameId: "fm-2023", name: "Demo Qualifying Variant", author: "RaceIQ Demo", carId: secondCar,
        category: "road", trackId: fm.trackId, description: `Second-car tune (${SEED_MARKER})`,
        strengths: JSON.stringify(["Rotation"]), weaknesses: JSON.stringify(["Tyre wear"]), bestTracks: "[]", strategies: "[]",
        settings: JSON.stringify({ frontArb: 28, rearArb: 34 }), unitSystem: "metric", source: SEED_MARKER,
      }).returning({ id: tunes.id }).get();
      await db.insert(tuneAssignments).values({ gameId: "fm-2023", carId: secondCar, trackId: fm.trackId, tuneId: tuneB.id }).run();
    }
    await db.update(laps).set({ tuneId: tuneA.id }).where(inArray(laps.id, fmLaps.map((lap) => lap.id))).run();
    await saveChatMessages(chatThreadId(fm.id), [
      {
        role: "user",
        markdown: "Where can I improve this lap?",
      },
    ]);
  }

  const f1Laps = importedLaps.filter((lap) => lap.gameId === "f1-2025");
  const f1 = f1Laps[0];
  if (f1) {
    const experiment = await db.insert(experiments).values({
      seq: 1, gameId: "f1-2025", name: "Demo setup experiment", carId: f1.carId,
      trackId: f1.trackId, focus: "car", notes: SEED_MARKER,
    }).returning({ id: experiments.id }).get();
    const base = await db.insert(experimentVersions).values({
      experimentId: experiment.id, version: 1, label: "Base setup", kind: "setup", setupPath: "seed/demo-base.json",
      appliedChanges: "[]", hypothesis: "Baseline reference", prediction: "Reference pace", status: "active",
    }).returning({ id: experimentVersions.id }).get();
    const drill = await db.insert(experimentVersions).values({
      experimentId: experiment.id, version: 2, label: "Brake later drill", parentVersionId: base.id, kind: "drill",
      appliedChanges: JSON.stringify([{ kind: "drill", description: "Brake later and release smoothly" }]),
      hypothesis: "Later release preserves entry speed", prediction: "Faster sector one", status: "active",
    }).returning({ id: experimentVersions.id }).get();
    await db.update(experiments).set({ headVersionId: drill.id, focus: "driver" }).where(eq(experiments.id, experiment.id)).run();
    await db.insert(experimentFocusEvents).values([
      { experimentId: experiment.id, focus: "car", fromVersionId: null, note: "Initial setup focus" },
      { experimentId: experiment.id, focus: "driver", fromVersionId: drill.id, note: "Switch to technique" },
    ]).run();
    await db.update(laps).set({ experimentVersionId: drill.id }).where(inArray(laps.id, f1Laps.map((lap) => lap.id))).run();
  }

  if (fmLaps.length >= 2) {
    const faster = [...fmLaps].sort((a, b) => a.id - b.id).at(-1)?.id ?? fmLaps[0].id;
    const slower = fmLaps.find((lap) => lap.id !== faster)?.id ?? fmLaps[0].id;
    const marker = `<!-- ${SEED_MARKER} -->`;
    await db.insert(lapAnalyses).values({ lapId: faster, analysis: `${marker}\n## Demo lap analysis\nThis seeded lap is available for local UI development.`, model: "seed", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }).run();
    await db.insert(compareAnalyses).values({ lapAId: Math.min(faster, slower), lapBId: Math.max(faster, slower), kind: "inputs", analysis: `${marker}\n## Demo comparison\nThe seeded laps provide a faster/slower comparison for local development.`, model: "seed", inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }).run();
    await saveChatMessages(compareChatThreadId(faster, slower), [
      {
        role: "user",
        markdown: "What changed between these laps?",
      },
    ]);
  }
}
