import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getLapById, type LoadedLap } from "../db/lap-read-queries";
import { db } from "../db/index";
import { laps } from "../db/schema";
import { cacheDelete } from "../db/telemetry-replay-storage";
import { assessLapRecording } from "../lap-analysis/quality";
import {
  prepareCompletedLapFindings,
  type CompletedLapFindingResult,
  type PreparedCompletedLapFindings,
} from "./completed-lap";
import { publishFindingGeneration } from "./publication";
import { replaceFindingGenerationsBatch } from "./store";

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
  const prepared: PreparedCompletedLapFindings[] = [];
  const lapIds: number[] = [];
  for (const { id } of rows) {
    const lap = await getLapById(id);
    if (!lap) throw new Error(`Completed lap ${id} disappeared during finding rebuild`);
    if (lap.sessionId !== sessionId || lap.gameId !== gameId) {
      throw new Error(`Completed lap ${id} no longer belongs to session ${sessionId}`);
    }
    if (!lap.quality) throw new Error(`Completed lap ${id} lacks finalized quality`);
    prepared.push(prepareCompletedLapFindings({
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
      eligibility: lap.eligibility ?? null,
      qualityGeneration: lap.qualityGeneration ?? null,
      qualityStale: lap.qualityStale,
      recordingQuality: assessLapRecording(lap.telemetry, lap.lapTime),
      analysisGenerationId: lap.analysisGenerationId ?? null,
      versionIdentity: storedVersionIdentity(lap),
      createdAt: lap.createdAt,
    }));
    lapIds.push(id);
  }
  if (prepared.length === 0) return [];
  const receipts = await replaceFindingGenerationsBatch(prepared);
  const results: CompletedLapFindingResult[] = prepared.map((candidate, index) => {
    const receipt = receipts[index];
    if (!receipt) throw new Error("Atomic finding activation returned incomplete receipts");
    publishFindingGeneration(candidate.scope, receipt, candidate.findingIds);
    return { scope: candidate.scope, receipt, findingIds: candidate.findingIds };
  });
  for (const id of lapIds) cacheDelete(id);
  return results;
}
