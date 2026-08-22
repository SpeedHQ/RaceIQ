import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getLapById, type LoadedLap } from "../db/lap-read-queries";
import { db } from "../db/index";
import { laps } from "../db/schema";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { assessLapRecording } from "../lap-analysis/quality";
import { persistCompletedLapFindings, type CompletedLapFindingResult } from "./completed-lap";

function storedVersionIdentity(lap: LoadedLap): TelemetryVersionIdentity {
  const qualityVersion = lap.quality?.versionIdentity;
  const catalogVersion = lap.catalogVersion ?? qualityVersion?.catalogVersion;
  const catalogHash = lap.catalogHash ?? qualityVersion?.catalogHash;
  const catalogSchemaVersion = lap.catalogSchemaVersion ?? qualityVersion?.catalogSchemaVersion;
  const parserVersion = lap.parserVersion ?? qualityVersion?.parserVersion;
  const resolverVersion = lap.resolverVersion ?? qualityVersion?.resolverVersion;
  const derivationVersion = lap.derivationVersion ?? qualityVersion?.derivationVersion;
  if (!catalogVersion || !catalogHash || !catalogSchemaVersion || !parserVersion || !resolverVersion || !derivationVersion) {
    throw new Error(`Completed lap ${lap.id} lacks persisted telemetry version identity`);
  }
  return {
    catalogVersion,
    catalogHash,
    catalogSchemaVersion,
    parserVersion,
    resolverVersion,
    derivationVersion,
  };
}

/**
 * Activates findings only after session quality has been finalized and committed.
 * Every input is reloaded from durable lap metadata and telemetry, so recorder
 * verification facts participate in the finding generation.
 */
export async function rebuildCompletedSessionFindings(
  sessionId: number,
  gameId: GameId,
): Promise<readonly CompletedLapFindingResult[]> {
  const rows = await db
    .select({ id: laps.id })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .all();
  const results: CompletedLapFindingResult[] = [];

  for (const { id } of rows) {
    cacheDelete(id);
    const lap = await getLapById(id);
    if (!lap) throw new Error(`Completed lap ${id} disappeared during finding rebuild`);
    if (lap.sessionId !== sessionId || lap.gameId !== gameId) {
      throw new Error(`Completed lap ${id} no longer belongs to session ${sessionId}`);
    }
    if (!lap.quality?.complete) continue;

    results.push(await persistCompletedLapFindings({
      lapId: lap.id,
      sessionId: lap.sessionId,
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      isValid: lap.isValid,
      invalidReason: lap.invalidReason ?? null,
      gameId,
      carOrdinal: lap.carOrdinal,
      trackOrdinal: lap.trackOrdinal,
      sectorTimes: lap.sectorTimes ?? null,
      telemetry: lap.telemetry,
      quality: lap.quality,
      recordingQuality: assessLapRecording(lap.telemetry, lap.lapTime),
      analysisGenerationId: lap.analysisGenerationId ?? null,
      versionIdentity: storedVersionIdentity(lap),
      createdAt: lap.createdAt,
    }));
  }

  return results;
}
