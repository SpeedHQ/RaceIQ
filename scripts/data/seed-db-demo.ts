import { db } from "../../server/db/index";
import { sessions, laps, tunes, tuneAssignments, experiments, experimentVersions, experimentFocusEvents, lapAnalyses, compareAnalyses } from "../../server/db/schema";
import { eq, inArray } from "drizzle-orm";
import { chatThreadId, compareChatThreadId, saveChatMessages } from "../../server/ai/chat-agent";
import { loadSettings, saveSettings } from "../../server/runtime/config/settings";
import { SEED_MARKER } from "./seed-db-options";

export function markOnboardingComplete(): void {
  saveSettings({ ...loadSettings(), onboardingComplete: true });
}

export async function insertDemoRows(profileId: number, importedLapIds: number[]): Promise<void> {
  const importedLaps = await db.select({ id: laps.id, gameId: sessions.gameId, carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal })
    .from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(inArray(laps.id, importedLapIds)).all();
  await db.update(laps).set({ profileId }).where(inArray(laps.id, importedLapIds)).run();

  const fmLaps = importedLaps.filter((lap) => lap.gameId === "fm-2023");
  const fm = fmLaps.find((lap) => lap.carOrdinal === 3631) ?? fmLaps[0];
  if (fm) {
    const secondCar = 3632;
    const tuneA = await db.insert(tunes).values({
      gameId: "fm-2023", name: "Demo Sprint Baseline", author: "RaceIQ Demo", carOrdinal: fm.carOrdinal,
      category: "road", trackOrdinal: fm.trackOrdinal, description: `Seeded demo tune (${SEED_MARKER})`,
      strengths: JSON.stringify(["Stable braking"]), weaknesses: JSON.stringify(["Corner exit traction"]),
      bestTracks: JSON.stringify(["Silverstone"]), strategies: JSON.stringify(["Brake earlier for consistency"]),
      settings: JSON.stringify({ frontArb: 32, rearArb: 28 }), unitSystem: "metric", source: SEED_MARKER,
    }).returning({ id: tunes.id }).get();
    const tuneB = await db.insert(tunes).values({
      gameId: "fm-2023", name: "Demo Qualifying Variant", author: "RaceIQ Demo", carOrdinal: secondCar,
      category: "road", trackOrdinal: fm.trackOrdinal, description: `Second-car tune (${SEED_MARKER})`,
      strengths: JSON.stringify(["Rotation"]), weaknesses: JSON.stringify(["Tyre wear"]), bestTracks: "[]", strategies: "[]",
      settings: JSON.stringify({ frontArb: 28, rearArb: 34 }), unitSystem: "metric", source: SEED_MARKER,
    }).returning({ id: tunes.id }).get();
    await db.insert(tuneAssignments).values({ gameId: "fm-2023", carOrdinal: fm.carOrdinal, trackOrdinal: fm.trackOrdinal, tuneId: tuneA.id }).run();
    await db.insert(tuneAssignments).values({ gameId: "fm-2023", carOrdinal: secondCar, trackOrdinal: fm.trackOrdinal, tuneId: tuneB.id }).run();
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
      seq: 1, gameId: "f1-2025", name: "Demo setup experiment", carOrdinal: f1.carOrdinal,
      trackOrdinal: f1.trackOrdinal, focus: "car", notes: SEED_MARKER,
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
