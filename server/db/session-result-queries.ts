import { eq, desc, and, inArray } from "drizzle-orm";
import { db } from "./index";
import { sessions, sessionResults, pitEvents } from "./schema";
import type { GameId } from "../../shared/types";
import type { RaceResultEvidence, RaceResultOutcomeStatus, RaceResultProvenance, RaceResultStatus } from "../../shared/race-results";

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
  sessionType: string;
  classification: RaceResultStatus;
  outcomeStatus: RaceResultOutcomeStatus;
  finishingPosition: number | null;
  qualifyingPosition: number | null;
  isPodium: boolean | null;
  isFastestLap: boolean | null;
  pitCount: number;
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: RaceResultProvenance;
  evidence: RaceResultEvidence;
  reasons: string[];
};


export type PitEventInput = {
  sequence: number;
  lapNumber: number | null;
  elapsedSeconds: number | null;
  durationSeconds: number | null;
  service: string;
  tyreChange: unknown;
  fuelAdded: number | null;
  fuelBefore: number | null;
  fuelAfter: number | null;
  linkage: string;
  source: unknown;
};


export async function upsertSessionResult(
  input: SessionResultInput,
  events?: PitEventInput[],
): Promise<{ id: number; changed: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: sessionResults.id })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, input.sessionId))
      .get();
    const values = {
      sessionId: input.sessionId,
      sessionType: input.sessionType,
      classification: input.classification,
      outcomeStatus: input.outcomeStatus,
      finishingPosition: input.finishingPosition,
      qualifyingPosition: input.qualifyingPosition,
      isPodium: input.isPodium,
      isFastestLap: input.isFastestLap,
      pitCount: input.pitCount,
      tyreStrategy: input.tyreStrategy,
      fuelStrategy: input.fuelStrategy,
      provenance: input.provenance,
      evidence: input.evidence,
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
}


export async function replacePitEvents(resultId: number, events: PitEventInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(pitEvents).where(eq(pitEvents.resultId, resultId));
    if (events.length > 0) {
      await tx.insert(pitEvents).values(events.map((event) => ({ resultId, ...event })));
    }
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
