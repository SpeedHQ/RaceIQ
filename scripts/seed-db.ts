import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { db, client, initDb } from "../server/db/index";
import { chatThreadId, compareChatThreadId, getChatMemory, listThreadGenerations, saveChatMessages } from "../server/ai/chat-agent";
import { importSessionBin } from "../server/session-capture/import-capture";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { sessions, laps, profiles, tunes, tuneAssignments, experiments, experimentVersions, experimentFocusEvents, lapAnalyses, compareAnalyses } from "../server/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { deleteSession } from "../server/db/session-queries";
import { getServerGame } from "../server/games/registry";
import { readIRacingFrames } from "../server/games/iracing/recorder";
import { registerImportedIRacingIdentity } from "../server/games/iracing/identity";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../server/telemetry/live-pipeline"
import { NullWsAdapter, RealDbAdapter, RealSessionRecorderAdapter } from "../server/telemetry/pipeline-ports"
import { loadSettings, saveSettings } from "../server/runtime/config/settings";
import type { GameId } from "../shared/games/ids";

const SEED_MARKER = "raceiq-demo-seed-v1";
const PROFILE_NAME = "RaceIQ Demo Driver";
const DEFAULT_GAMES: GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"];
const FIXTURES: Record<GameId, string[]> = {
  "fm-2023": ["test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz"],
  "f1-2025": ["test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz"],
  acc: ["test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz"],
  "ac-evo": ["test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz"],
  iracing: ["test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz"],
};

type SeedOptions = { reset: boolean; force: boolean; games: GameId[] };

function parseOptions(): SeedOptions {
  const reset = process.argv.includes("--reset");
  const force = process.argv.includes("--force");
  const gamesArg = process.argv.find((arg) => arg.startsWith("--games="))?.slice("--games=".length)
    ?? (process.argv.includes("--games") ? process.argv[process.argv.indexOf("--games") + 1] : undefined);
  const games = (gamesArg ? gamesArg.split(",") : DEFAULT_GAMES).filter((game): game is GameId => DEFAULT_GAMES.includes(game as GameId));
  if (games.length === 0) throw new Error("--games must include at least one of fm-2023,f1-2025,acc,ac-evo,iracing");
  return { reset, force, games };
}

async function countRows(table: string): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function seedRowCount(): Promise<number> {
  const result = await client.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM sessions WHERE notes LIKE ?) +
      (SELECT COUNT(*) FROM experiments WHERE notes LIKE ?) +
      (SELECT COUNT(*) FROM tunes WHERE source = ?) AS count`,
    args: [`%${SEED_MARKER}%`, `%${SEED_MARKER}%`, SEED_MARKER],
  });
  return Number(result.rows[0]?.count ?? 0);
}

async function assertSafeTarget(force: boolean): Promise<void> {
  const seeded = await seedRowCount();
  if (seeded > 0) return;
  const counts = await Promise.all(["sessions", "laps", "tunes", "experiments"].map(countRows));
  const userRows = counts.reduce((sum, count) => sum + count, 0);
  if (userRows > 0 && !force) {
    throw new Error("Refusing to seed a database containing user data. Use DATA_DIR for a disposable database or pass --force.");
  }
}

async function removeSeedData(): Promise<void> {
  const sessionRows = await db.select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions).where(like(sessions.notes, `%${SEED_MARKER}%`)).all();
  const seededLaps = sessionRows.length
    ? await db
        .select({ id: laps.id, gameId: sessions.gameId })
        .from(laps)
        .innerJoin(sessions, eq(laps.sessionId, sessions.id))
        .where(inArray(sessions.id, sessionRows.map((row) => row.id)))
        .all()
    : [];
  const experimentRows = await db.select({ id: experiments.id }).from(experiments).where(like(experiments.notes, `%${SEED_MARKER}%`)).all();
  const tuneRows = await db.select({ id: tunes.id }).from(tunes).where(eq(tunes.source, SEED_MARKER)).all();
  const chatBases = seededLaps.map((lap) => chatThreadId(lap.id));
  const fmLapIds = seededLaps
    .filter((lap) => lap.gameId === "fm-2023")
    .map((lap) => lap.id)
    .sort((a, b) => a - b);
  if (fmLapIds.length >= 2) {
    const latestFmLapId = fmLapIds[fmLapIds.length - 1];
    if (latestFmLapId !== undefined) chatBases.push(compareChatThreadId(latestFmLapId, fmLapIds[0]));
  }
  if (chatBases.length > 0) {
    const memory = getChatMemory();
    for (const base of chatBases) {
      const threadIds = new Set((await listThreadGenerations(base)).map((generation) => generation.threadId));
      threadIds.add(base);
      for (const threadId of threadIds) await memory.deleteThread(threadId);
    }
  }

  if (experimentRows.length) {
    await db.delete(experimentFocusEvents).where(inArray(experimentFocusEvents.experimentId, experimentRows.map((row) => row.id))).run();
    await db.delete(experimentVersions).where(inArray(experimentVersions.experimentId, experimentRows.map((row) => row.id))).run();
    await db.delete(experiments).where(inArray(experiments.id, experimentRows.map((row) => row.id))).run();
  }
  if (tuneRows.length) {
    await db.delete(tuneAssignments).where(inArray(tuneAssignments.tuneId, tuneRows.map((row) => row.id))).run();
    await db.delete(tunes).where(inArray(tunes.id, tuneRows.map((row) => row.id))).run();
  }
  for (const row of sessionRows) {
    await deleteSession(row.id);
    if (row.rawFile && existsSync(row.rawFile)) unlinkSync(row.rawFile);
  }
  const seedProfile = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.name, PROFILE_NAME)).all();
  if (seedProfile.length) await db.delete(profiles).where(inArray(profiles.id, seedProfile.map((row) => row.id))).run();
  await db.delete(lapAnalyses).where(like(lapAnalyses.analysis, `%${SEED_MARKER}%`)).run();
  await db.delete(compareAnalyses).where(like(compareAnalyses.analysis, `%${SEED_MARKER}%`)).run();
}

async function seedIRacingSession(fixturePath: string): Promise<void> {
  const existingSessionIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all()).map((row) => row.id),
  );
  const adapter = getServerGame("iracing");
  const parserState = adapter.createParserState?.() ?? null;
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter(), new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    recorder: new RealSessionRecorderAdapter(),
  });
  let packetCount = 0;
  let identityRegistered = false;
  for (const sourceFrame of readIRacingFrames(fixturePath)) {
    const packet = adapter.tryParse(sourceFrame, parserState);
    if (!packet) continue;
    if (!identityRegistered && packet.iracing) {
      await registerImportedIRacingIdentity({
        carId: packet.CarOrdinal,
        carName: packet.iracing.carName,
        trackId: packet.TrackOrdinal,
        trackName: packet.iracing.trackName,
      });
      identityRegistered = true;
    }
    await pipeline.processPacket(packet, sourceFrame);
    packetCount++;
  }
  await pipeline.flushIncompleteLap();
  await pipeline.flushSessionRecorder();

  const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all())
    .map((row) => row.id)
    .filter((id) => !existingSessionIds.has(id));
  if (seededSessionIds.length === 0 || packetCount === 0) {
    throw new Error(`No iRacing telemetry imported from ${fixturePath}`);
  }
  await db.update(sessions).set({ notes: SEED_MARKER, source: "seed" }).where(inArray(sessions.id, seededSessionIds)).run();
  console.log(`[DB Seed] iracing: ${packetCount} telemetry packets from ${fixturePath}`);
}

function markOnboardingComplete(): void {
  saveSettings({ ...loadSettings(), onboardingComplete: true });
}

async function insertDemoRows(profileId: number, importedLapIds: number[]): Promise<void> {
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
        id: `${SEED_MARKER}-lap-question`,
        role: "user",
        parts: [{ type: "text", text: "Where can I improve this lap?" }],
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
        id: `${SEED_MARKER}-compare-question`,
        role: "user",
        parts: [{ type: "text", text: "What changed between these laps?" }],
      },
    ]);
  }
}
async function main(): Promise<void> {
  const options = parseOptions();
  await initDb();
  initGameAdapters();
  initServerGameAdapters();
  await assertSafeTarget(options.force);
  if (options.reset) await removeSeedData();
  if (await seedRowCount()) {
    markOnboardingComplete();
    console.log("[DB Seed] Seed data already exists; nothing to do.");
    return;
  }

  const profile = await db.insert(profiles).values({ name: PROFILE_NAME }).returning({ id: profiles.id }).get();
  const importedLapIds: number[] = [];
  for (const game of options.games) {
    for (const fixture of FIXTURES[game]) {
      const fixturePath = resolve(import.meta.dir, "..", fixture);
      if (!existsSync(fixturePath)) throw new Error(`Missing seed fixture: ${fixturePath}`);
      if (game === "iracing") {
        await seedIRacingSession(fixturePath);
        continue;
      }
      const existingSessionIds = new Set(
        (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all()).map((row) => row.id),
      );
      const result = await importSessionBin(readFileSync(fixturePath), game);
      const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all())
        .map((row) => row.id)
        .filter((id) => !existingSessionIds.has(id));
      if (seededSessionIds.length === 0) {
        throw new Error(`No ${game} telemetry imported from ${fixturePath}`);
      }
      await db.update(sessions).set({ notes: SEED_MARKER, source: "seed" }).where(inArray(sessions.id, seededSessionIds)).run();
      importedLapIds.push(...result.laps.filter((lap) => lap.isValid).map((lap) => lap.lapId));
      console.log(`[DB Seed] ${game}: ${result.laps.length} laps from ${fixture}`);
    }
  }
  if (importedLapIds.length) await insertDemoRows(profile.id, importedLapIds);
  markOnboardingComplete();
  console.log(`[DB Seed] Complete: ${importedLapIds.length} valid laps, ${options.games.join(", ")}.`);
}

try {
  await main();
} finally {
  stopMaintenanceTasks();
  client.close();
}
