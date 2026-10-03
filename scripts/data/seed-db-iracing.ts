import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { registerImportedIRacingIdentity } from "@raceiq/game-iracing/identity";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter, RealSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { SEED_MARKER } from "./seed-db-options";

export async function seedIRacingSession(fixturePath: string): Promise<void> {
  const existingSessionIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all()).map((row) => row.id),
  );
  const adapter = getServerGame("iracing");
  const parserState = adapter.createParserState?.() ?? null;
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter(), new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    skipHistorySeeding: true,
    skipDevState: true,
    ...(process.env.PW_SEED_SCREENSHOTS === "1" ? {} : { recorder: new RealSessionRecorderAdapter() }),
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
  await pipeline.finalizeCurrentSession();

  const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, "iracing")).all())
    .map((row) => row.id)
    .filter((id) => !existingSessionIds.has(id));
  if (seededSessionIds.length === 0 || packetCount === 0) {
    throw new Error(`No iRacing telemetry imported from ${fixturePath}`);
  }
  await db.update(sessions).set({ notes: SEED_MARKER }).where(inArray(sessions.id, seededSessionIds)).run();
  console.log(`[DB Seed] iracing: ${packetCount} telemetry packets from ${fixturePath}`);
}

