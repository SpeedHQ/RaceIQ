import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import type {
  RaceResultEvidence,
  RaceResultLapQualityEvidence,
  RaceResultOutcomeStatus,
  RaceResultProvenance,
  RaceResultStatus,
} from "../../shared/racing/results/types";
import { resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import { db } from "./index";
import { laps, sessionResults, sessions } from "./schema";

const UNAVAILABLE_RACE_RESULT_EVIDENCE: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "unavailable",
    classification: "unavailable",
    finishingPosition: "unavailable",
    qualifyingPosition: "unavailable",
    isPodium: "unavailable",
    isFastestLap: "unavailable",
    pitTimeline: "unavailable",
    tyreStrategy: "unavailable",
    fuelStrategy: "unavailable",
  },
  conflicts: [],
};

const LEGACY_RACE_RESULT_PROVENANCE: RaceResultProvenance = {
  catalogVersion: "unavailable",
  catalogHash: "unavailable",
  catalogSchemaVersion: "unavailable",
  parserVersion: "unavailable",
  resolverVersion: "unavailable",
  derivationId: "unavailable",
  derivationVersion: "unavailable",
  derivationCodeHash: "unavailable",
  rawInput: null,
  canonicalInput: null,
  authorityPolicyId: "legacy-outcome-status",
  authorityPolicyVersion: "unavailable",
};

export async function loadRaceResultLapQuality(
  sessionIds: readonly number[],
): Promise<Map<number, RaceResultLapQualityEvidence[]>> {
  const result = new Map<number, RaceResultLapQualityEvidence[]>();
  if (sessionIds.length === 0) return result;
  const rows = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      quality: laps.quality,
      eligibility: laps.eligibility,
      qualityGeneration: laps.qualityGeneration,
    })
    .from(laps)
    .where(inArray(laps.sessionId, [...sessionIds]))
    .orderBy(laps.sessionId, laps.lapNumber, laps.id)
    .all();
  for (const row of rows) {
    const evidence: RaceResultLapQualityEvidence = {
      lapId: row.id,
      lapNumber: row.lapNumber,
      qualityGeneration: row.qualityGeneration,
      officialTiming: resolveEligibilityDecision(row, "official-timing"),
      normalPace: resolveEligibilityDecision(row, "normal-pace"),
    };
    const values = result.get(row.sessionId);
    if (values) values.push(evidence);
    else result.set(row.sessionId, [evidence]);
  }
  return result;
}

export interface SessionResultInput {
  sessionId: number;
  processorVersion?: string;
  sessionType: string;
  classification: RaceResultStatus;
  outcomeStatus?: RaceResultOutcomeStatus;
  finishingPosition: number | null;
  qualifyingPosition: number | null;
  isPodium: boolean | null;
  isFastestLap: boolean | null;
  pitCount: number;
  eventIds: RaceEventId[];
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance?: RaceResultProvenance;
  evidence?: RaceResultEvidence;
  reasons: string[];
}

export async function upsertSessionResult(
  input: SessionResultInput,
): Promise<{ id: number; changed: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: sessionResults.id })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, input.sessionId))
      .get();
    const values = {
      sessionId: input.sessionId,
      processorVersion: input.processorVersion ?? "race-result-v4",
      sessionType: input.sessionType,
      classification: input.classification,
      outcomeStatus: input.outcomeStatus ?? "unavailable",
      finishingPosition: input.finishingPosition,
      qualifyingPosition: input.qualifyingPosition,
      isPodium: input.isPodium,
      isFastestLap: input.isFastestLap,
      pitCount: input.pitCount,
      eventIds: input.eventIds,
      tyreStrategy: input.tyreStrategy,
      fuelStrategy: input.fuelStrategy,
      provenance: input.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
      evidence: input.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
      reasons: input.reasons,
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      await tx.update(sessionResults).set(values).where(eq(sessionResults.id, existing.id)).run();
      return { id: existing.id, changed: true };
    }
    const inserted = await tx.insert(sessionResults).values(values).returning({ id: sessionResults.id }).get();
    return { id: inserted.id, changed: true };
  });
}

function resultDto(
  row: typeof sessionResults.$inferSelect,
  gameId: GameId,
  lapQuality: RaceResultLapQualityEvidence[],
) {
  return {
    ...row,
    gameId,
    outcomeStatus: row.outcomeStatus ?? ("unavailable" as const),
    provenance: row.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
    evidence: row.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
    eventIds: row.eventIds ?? [],
    reasons: row.reasons ?? [],
    lapQuality,
  };
}

export async function getSessionResult(sessionId: number, gameId: GameId) {
  const row = await db
    .select({ result: sessionResults, gameId: sessions.gameId })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(eq(sessionResults.sessionId, sessionId), eq(sessions.gameId, gameId)))
    .get();
  if (!row) return null;
  const lapQuality = await loadRaceResultLapQuality([sessionId]);
  return resultDto(row.result, row.gameId as GameId, lapQuality.get(sessionId) ?? []);
}

export async function getRecentSessionResults(gameId: GameId, limit: number) {
  const rows = await db
    .select({ result: sessionResults, gameId: sessions.gameId })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(eq(sessions.gameId, gameId))
    .orderBy(desc(sessions.id))
    .limit(limit)
    .all();
  const quality = await loadRaceResultLapQuality(rows.map(({ result }) => result.sessionId));
  return rows.map(({ result, gameId: storedGameId }) =>
    resultDto(result, storedGameId as GameId, quality.get(result.sessionId) ?? []),
  );
}

export async function countStaleRaceResults(currentProcessorVersion: string): Promise<number> {
  const rows = await db
    .select({ sessionId: sessions.id })
    .from(sessions)
    .leftJoin(sessionResults, eq(sessionResults.sessionId, sessions.id))
    .where(or(isNull(sessionResults.id), ne(sessionResults.processorVersion, currentProcessorVersion)))
    .all();
  return rows.length;
}

export async function getStaleRaceResultSessionIds(currentProcessorVersion: string): Promise<number[]> {
  const rows = await db
    .select({ sessionId: sessions.id })
    .from(sessions)
    .leftJoin(sessionResults, eq(sessionResults.sessionId, sessions.id))
    .where(or(isNull(sessionResults.id), ne(sessionResults.processorVersion, currentProcessorVersion)))
    .orderBy(sessions.id)
    .all();
  return rows.map(({ sessionId }) => sessionId);
}
