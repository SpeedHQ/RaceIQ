import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "./index";
import { compareAnalyses, lapAnalyses, laps, pitEvents, sessionResults, sessions } from "./schema";

import { type GameId } from "../../shared/games/ids";
import type { RaceResultEvidence, RaceResultLapQualityEvidence, RaceResultOutcomeStatus, RaceResultProvenance, RaceResultStatus } from "../../shared/racing/results/types";
import { resolveEligibilityDecision } from "../../shared/racing/quality/policies";

const UNAVAILABLE_RACE_RESULT_EVIDENCE: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "unavailable",
    classification: "unavailable",
    finishingPosition: "unavailable",
    qualifyingPosition: "unavailable",
    isPodium: "unavailable",
    isFastestLap: "unavailable",
    pitEvents: "unavailable",
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
export async function loadRaceResultLapQuality(sessionIds: readonly number[]): Promise<Map<number, RaceResultLapQualityEvidence[]>> {
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
    const sessionQuality = result.get(row.sessionId);
    if (sessionQuality) sessionQuality.push(evidence);
    else result.set(row.sessionId, [evidence]);
  }
  return result;
}

export type SessionResultInput = {
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
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance?: RaceResultProvenance;
  evidence?: RaceResultEvidence;
  reasons: string[];
};

export type PitEventInput = {
  sequence: number;
  eventType?: string;
  lapNumber: number | null;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
  service: string;
  tyreChange: unknown;
  fuelAdded: number | null;
  fuelBefore: number | null;
  fuelAfter: number | null;
  positionBefore?: number | null;
  positionAfter?: number | null;
  linkage: string;
  source: unknown;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function markPitCycleLaps(tx: DbTransaction, sessionId: number, events: readonly PitEventInput[]): Promise<void> {
  const inlapNumbers = [...new Set(events.filter((event) => (event.eventType ?? "pit") === "pit" && event.linkage === "linked" && event.lapNumber !== null).map((event) => event.lapNumber!))];
  if (inlapNumbers.length === 0) return;
  const outlapNumbers = inlapNumbers.map((lapNumber) => lapNumber + 1);

  await tx
    .update(laps)
    .set({ phase: "in", paceEligibility: "excluded" })
    .where(and(eq(laps.sessionId, sessionId), inArray(laps.lapNumber, inlapNumbers)))
    .run();
  await tx
    .update(laps)
    .set({ phase: "out", paceEligibility: "excluded" })
    .where(and(eq(laps.sessionId, sessionId), inArray(laps.lapNumber, outlapNumbers)))
    .run();

  const session = await tx.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sessionId)).get();
  const affectedLaps = await tx
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      phase: laps.phase,
      conditions: laps.conditions,
      paceEligibility: laps.paceEligibility,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      quality: laps.quality,
      qualitySchemaVersion: laps.qualitySchemaVersion,
      qualityPolicyVersion: laps.qualityPolicyVersion,
      qualityConfigVersion: laps.qualityConfigVersion,
      qualityGeneration: laps.qualityGeneration,
    })
    .from(laps)
    .where(and(eq(laps.sessionId, sessionId), inArray(laps.lapNumber, [...new Set([...inlapNumbers, ...outlapNumbers])])))
    .all();
  const changedLapIds: number[] = [];

  for (const lap of affectedLaps) {
    if (!lap.quality) continue;
    const quality = {
      ...lap.quality,
      classification: {
        phase: lap.phase,
        conditions: lap.conditions,
        paceEligibility: lap.paceEligibility,
      },
    };
    const generated = finalizeLapQualityGeneration(quality, session?.recordingQuality?.provenance.sourceGeneration ?? "legacy", {
      lapNumber: lap.lapNumber,
      rawByteOffset: lap.rawByteOffset,
      rawFrameCount: lap.rawFrameCount ?? 0,
    });
    if (
      generated.quality.provenance.outputGeneration === lap.qualityGeneration &&
      generated.quality.provenance.schemaVersion === lap.qualitySchemaVersion &&
      generated.quality.provenance.policyVersion === lap.qualityPolicyVersion &&
      generated.quality.provenance.configurationVersion === lap.qualityConfigVersion
    ) {
      continue;
    }
    await tx
      .update(laps)
      .set({
        quality: generated.quality,
        eligibility: generated.eligibility,
        qualitySchemaVersion: generated.quality.provenance.schemaVersion,
        qualityPolicyVersion: generated.quality.provenance.policyVersion,
        qualityConfigVersion: generated.quality.provenance.configurationVersion,
        qualityGeneration: generated.quality.provenance.outputGeneration,
      })
      .where(eq(laps.id, lap.id))
      .run();
    changedLapIds.push(lap.id);
  }

  if (changedLapIds.length > 0) {
    await tx.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, changedLapIds)).run();
    await tx
      .delete(compareAnalyses)
      .where(or(inArray(compareAnalyses.lapAId, changedLapIds), inArray(compareAnalyses.lapBId, changedLapIds)))
      .run();
  }
}

export async function upsertSessionResult(input: SessionResultInput, events?: PitEventInput[]): Promise<{ id: number; changed: boolean }> {
  const result = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: sessionResults.id }).from(sessionResults).where(eq(sessionResults.sessionId, input.sessionId)).get();
    const values = {
      sessionId: input.sessionId,
      processorVersion: input.processorVersion ?? "race-result-v2",
      sessionType: input.sessionType,
      classification: input.classification,
      outcomeStatus: input.outcomeStatus ?? "unavailable",
      finishingPosition: input.finishingPosition,
      qualifyingPosition: input.qualifyingPosition,
      isPodium: input.isPodium,
      isFastestLap: input.isFastestLap,
      pitCount: input.pitCount,
      tyreStrategy: input.tyreStrategy,
      fuelStrategy: input.fuelStrategy,
      provenance: input.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
      evidence: input.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
      reasons: input.reasons,
      updatedAt: new Date().toISOString(),
    };
    const id = existing ? existing.id : (await tx.insert(sessionResults).values(values).returning({ id: sessionResults.id }).get()).id;
    if (existing) {
      await tx.update(sessionResults).set(values).where(eq(sessionResults.id, existing.id)).run();
    }
    if (events !== undefined) {
      await tx.delete(pitEvents).where(eq(pitEvents.resultId, id));
      if (events.length > 0) {
        await tx.insert(pitEvents).values(events.map((event) => ({ resultId: id, ...event })));
      }
      await markPitCycleLaps(tx, input.sessionId, events);
    }
    return { id, changed: true };
  });
  return result;
}

export async function replacePitEvents(resultId: number, events: PitEventInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    const result = await tx.select({ sessionId: sessionResults.sessionId }).from(sessionResults).where(eq(sessionResults.id, resultId)).get();
    await tx.delete(pitEvents).where(eq(pitEvents.resultId, resultId));
    if (events.length > 0) {
      await tx.insert(pitEvents).values(events.map((event) => ({ resultId, ...event })));
    }
    if (result) await markPitCycleLaps(tx, result.sessionId, events);
  });
}

export async function getSessionResult(sessionId: number, gameId: GameId) {
  const row = await db
    .select({ result: sessionResults, gameId: sessions.gameId })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(eq(sessionResults.sessionId, sessionId), eq(sessions.gameId, gameId)))
    .get();
  if (!row) return null;
  const [events, lapQualityBySession] = await Promise.all([
    db.select().from(pitEvents).where(eq(pitEvents.resultId, row.result.id)).orderBy(pitEvents.sequence).all(),
    loadRaceResultLapQuality([sessionId]),
  ]);
  return {
    ...row.result,
    gameId: row.gameId as GameId,
    outcomeStatus: row.result.outcomeStatus ?? "unavailable",
    provenance: row.result.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
    evidence: row.result.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
    reasons: row.result.reasons ?? [],
    lapQuality: lapQualityBySession.get(sessionId) ?? [],
    events,
  };
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
  if (rows.length === 0) return [];

  const [storedEvents, lapQualityBySession] = await Promise.all([
    db
      .select()
      .from(pitEvents)
      .where(
        inArray(
          pitEvents.resultId,
          rows.map((row) => row.result.id),
        ),
      )
      .orderBy(pitEvents.resultId, pitEvents.sequence)
      .all(),
    loadRaceResultLapQuality(rows.map((row) => row.result.sessionId)),
  ]);
  const eventsByResult = new Map<number, typeof storedEvents>();
  for (const event of storedEvents) {
    const events = eventsByResult.get(event.resultId);
    if (events) events.push(event);
    else eventsByResult.set(event.resultId, [event]);
  }

  return rows.map((row) => ({
    ...row.result,
    gameId: row.gameId as GameId,
    outcomeStatus: row.result.outcomeStatus ?? "unavailable",
    provenance: row.result.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
    evidence: row.result.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
    reasons: row.result.reasons ?? [],
    lapQuality: lapQualityBySession.get(row.result.sessionId) ?? [],

    events: eventsByResult.get(row.result.id) ?? [],
  }));
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
  return rows.map((row) => row.sessionId);
}
