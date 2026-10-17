import { readFileSync } from "node:fs";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { registerImportedIRacingIdentity } from "@raceiq/game-iracing/identity";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { convertSeedFramesToSparse } from "./seed-capture-conversion";
import { SEED_MARKER } from "./seed-db-options";

export async function seedIRacingSession(fixturePath: string): Promise<void> {
  const existingSessionIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all()).map((row) => row.id),
  );
  const adapter = getServerGame("iracing");
  const parserState = adapter.createParserState?.() ?? null;
  let identityRegistered = false;

  async function* sourceFrames(): AsyncGenerator<Buffer> {
    for (const sourceFrame of readIRacingFrames(fixturePath)) {
      const packet = adapter.tryParse(sourceFrame, parserState);
      if (!identityRegistered && packet?.iracing) {
        await registerImportedIRacingIdentity({
          carId: Number(packet.carId),
          carName: packet.iracing.carName,
          trackId: Number(packet.trackId),
          trackName: packet.iracing.trackName,
        });
        identityRegistered = true;
      }
      yield sourceFrame;
    }
  }

  console.log(`[DB Seed] iracing: converting ${fixturePath} to sparse format...`);
  const converted = await convertSeedFramesToSparse("iracing", sourceFrames());
  try {
    const result = await importSessionBin(readFileSync(converted.path), "iracing", {
      notifyDriverProfile: false,
      recorder: new SparseSessionRecorderAdapter("mine", {}, "offline"),
    });
    const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all())
      .map((row) => row.id)
      .filter((id) => !existingSessionIds.has(id));
    if (seededSessionIds.length === 0 || result.packetCount === 0) {
      throw new Error(`No iRacing telemetry imported from ${fixturePath}`);
    }
    await db.update(sessions).set({ notes: SEED_MARKER }).where(inArray(sessions.id, seededSessionIds)).run();
    console.log(`[DB Seed] iracing: ${result.packetCount} telemetry packets from ${fixturePath}`);
  } finally {
    converted.cleanup();
  }
}

