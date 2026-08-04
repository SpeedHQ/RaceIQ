import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, client, initDb } from "../../server/db/index";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { profiles, sessions } from "../../server/db/schema";
import { eq, inArray } from "drizzle-orm";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { seedIRacingSession } from "./seed-db-iracing";
import { assertSafeTarget, seedRowCount } from "./seed-db-safety";
import { insertDemoRows, markOnboardingComplete } from "./seed-db-demo";
import { removeSeedData } from "./seed-db-reset";
import { FIXTURES, PROFILE_NAME, parseOptions, SEED_MARKER } from "./seed-db-options";

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
      const fixturePath = resolve(import.meta.dir, "../..", fixture);
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
