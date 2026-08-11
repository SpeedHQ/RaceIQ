import { eq, desc, and, inArray, ne, or, isNull } from "drizzle-orm";
import { db } from "./index";
import { laps, sessions, sessionResults, pitEvents } from "./schema";
import type { GameId } from "../../shared/games/ids";
import type { RaceResultEvidence, RaceResultOutcomeStatus, RaceResultProvenance, RaceResultStatus } from "../../shared/racing/results/types";

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

async function markPitCycleLaps(sessionId: number, events: readonly PitEventInput[]): Promise<void> {
  const inlapNumbers = [...new Set(events.filter((event) => (event.eventType ?? "pit") === "pit" && event.linkage === "linked" && event.lapNumber !== null).map((event) => event.lapNumber!))];

  await db
    .update(laps)
    .set({ isValid: false, invalidReason: "inlap" })
    .where(and(eq(laps.sessionId, sessionId), eq(laps.isValid, true), inArray(laps.lapNumber, inlapNumbers)))
    .run();
  await db
    .update(laps)
    .set({ isValid: false, invalidReason: "outlap" })
    .where(and(eq(laps.sessionId, sessionId), eq(laps.isValid, true), inArray(laps.lapNumber, inlapNumbers.map((lapNumber) => lapNumber + 1))))
    .run();
}


export async function upsertSessionResult(
  input: SessionResultInput,
  events?: PitEventInput[],
): Promise<{ id: number; changed: boolean }> {
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: sessionResults.id })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, input.sessionId))
      .get();
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
    const id = existing
      ? existing.id
      : (await tx.insert(sessionResults).values(values).returning({ id: sessionResults.id }).get()).id;
    if (existing) {
      await tx.update(sessionResults).set(values).where(eq(sessionResults.id, existing.id)).run();
    }
    if (events !== undefined) {
      await tx.delete(pitEvents).where(eq(pitEvents.resultId, id));
      if (events.length > 0) {
        await tx.insert(pitEvents).values(events.map((event) => ({ resultId: id, ...event })));
      }
    }
    return { id, changed: true };
  });
  if (events !== undefined) await markPitCycleLaps(input.sessionId, events);
  return result;
}


export async function replacePitEvents(resultId: number, events: PitEventInput[]): Promise<void> {
  const result = await db.select({ sessionId: sessionResults.sessionId }).from(sessionResults).where(eq(sessionResults.id, resultId)).get();
  await db.transaction(async (tx) => {
    await tx.delete(pitEvents).where(eq(pitEvents.resultId, resultId));
    if (events.length > 0) {
      await tx.insert(pitEvents).values(events.map((event) => ({ resultId, ...event })));
    }
  });
  if (result) await markPitCycleLaps(result.sessionId, events);
}


export async function getSessionResult(sessionId: number, gameId: GameId) {
  const row = await db
    .select({ result: sessionResults, gameId: sessions.gameId })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(eq(sessionResults.sessionId, sessionId), eq(sessions.gameId, gameId)))
    .get();
  if (!row) return null;
  const events = await db
    .select()
    .from(pitEvents)
    .where(eq(pitEvents.resultId, row.result.id))
    .orderBy(pitEvents.sequence)
    .all();
  return {
    ...row.result,
    gameId: row.gameId as GameId,
    outcomeStatus: row.result.outcomeStatus ?? "unavailable",
    provenance: row.result.provenance ?? LEGACY_RACE_RESULT_PROVENANCE,
    evidence: row.result.evidence ?? UNAVAILABLE_RACE_RESULT_EVIDENCE,
    reasons: row.result.reasons ?? [],
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

  const storedEvents = await db
    .select()
    .from(pitEvents)
    .where(inArray(pitEvents.resultId, rows.map((row) => row.result.id)))
    .orderBy(pitEvents.resultId, pitEvents.sequence)
    .all();
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

    events: eventsByResult.get(row.result.id) ?? [],
  }));
}
export async function countStaleRaceResults(currentProcessorVersion: string): Promise<number> {
  const rows = await db
    .select({ sessionId: sessions.id })
    .from(sessions)
    .leftJoin(sessionResults, eq(sessionResults.sessionId, sessions.id))
    .where(
      or(
        isNull(sessionResults.id),
        ne(sessionResults.processorVersion, currentProcessorVersion),
      ),
    )
    .all();
  return rows.length;
}

export async function getStaleRaceResultSessionIds(currentProcessorVersion: string): Promise<number[]> {
  const rows = await db
    .select({ sessionId: sessions.id })
    .from(sessions)
    .leftJoin(sessionResults, eq(sessionResults.sessionId, sessions.id))
    .where(
      or(
        isNull(sessionResults.id),
        ne(sessionResults.processorVersion, currentProcessorVersion),
      ),
    )
    .orderBy(sessions.id)
    .all();
  return rows.map((row) => row.sessionId);
}
