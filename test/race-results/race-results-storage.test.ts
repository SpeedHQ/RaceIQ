import { describe, expect, test } from "bun:test";
import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import type { RaceResultEvidence, RaceResultProvenance } from "../../shared/racing/results/types";
import { appendRaceEvents } from "../../server/db/race-event-queries";
import {
  countStaleRaceResults,
  getRecentSessionResults,
  getSessionResult,
  getStaleRaceResultSessionIds,
  upsertSessionResult,
} from "../../server/db/session-result-queries";
import { insertSession } from "../../server/db/session-queries";
import { getRaceResultAggregate } from "../../server/race-results/aggregates";
import { RACE_RESULT_PROCESSOR_ID } from "../../server/race-results/reconcile";

const provenance: RaceResultProvenance = {
  catalogVersion: "test",
  catalogHash: "sha256:test",
  catalogSchemaVersion: "test",
  parserVersion: "test",
  resolverVersion: "test",
  derivationId: "race-result-derivation",
  derivationVersion: "4",
  derivationCodeHash: "sha256:test",
  rawInput: null,
  canonicalInput: null,
  authorityPolicyId: "race-result-outcome-authority",
  authorityPolicyVersion: "1",
};

const evidence: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "direct",
    classification: "direct",
    finishingPosition: "direct",
    qualifyingPosition: "direct",
    isPodium: "derived",
    isFastestLap: "derived",
    pitTimeline: "derived",
    tyreStrategy: "direct",
    fuelStrategy: "direct",
  },
  conflicts: [],
};

function id(character: string): RaceEventId {
  return `race-event:sha256:${character.repeat(64)}` as RaceEventId;
}

function event(
  sessionId: number,
  eventId: RaceEventId,
  input:
    | { eventType: "pit_entry"; payload: { previousState: "out"; state: "pit-lane" } }
    | { eventType: "pit_service_completed"; payload: { durationMs: number; observedActions: ["fuel"]; state: "pit-stall" } },
): RaceEvent {
  return {
    eventId,
    eventType: input.eventType,
    schemaVersion: "race-event-v1",
    sessionId,
    participantId: "local-player",
    participantKind: "player",
    driverId: null,
    teamId: null,
    timelineEpoch: 0,
    sequence: input.eventType === "pit_entry" ? 1 : 2,
    eventOrder: input.eventType === "pit_entry" ? 50 : 60,
    sourceTimeMs: 1_000,
    sourceEndTimeMs: input.eventType === "pit_entry" ? 1_000 : 21_000,
    sourceSequenceFamily: null,
    sourceSequence: null,
    receivedAtMs: 1_000,
    lapNumber: 3,
    lapId: null,
    trackDistanceM: null,
    trackDistancePct: null,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload: input.payload,
    lifecycleId: "visit:1",
    linkedEventId: null,
    detectorId: "test",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: `sha256:${eventId.slice(-64)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as RaceEvent;
}

describe("persisted race result timeline projections", () => {
  test("stores canonical supporting IDs without an embedded event ledger", async () => {
    const sessionId = await insertSession(99, 88, "f1-2025", "race");
    const pitEntry = event(sessionId, id("a"), {
      eventType: "pit_entry",
      payload: { previousState: "out", state: "pit-lane" },
    });
    await appendRaceEvents([pitEntry]);
    const stored = await upsertSessionResult({
      sessionId,
      processorVersion: RACE_RESULT_PROCESSOR_ID,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 2,
      qualifyingPosition: 5,
      isPodium: true,
      isFastestLap: false,
      pitCount: 1,
      eventIds: [pitEntry.eventId],
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });
    const result = await getSessionResult(sessionId, "f1-2025");
    expect(result?.id).toBe(stored.id);
    expect(result?.eventIds).toEqual([pitEntry.eventId]);
    expect(Object.keys(result ?? {})).not.toContain("events");
    expect((await getRecentSessionResults("f1-2025", 10))[0]?.eventIds).toEqual([pitEntry.eventId]);
  });

  test("aggregates pit duration from completed canonical services", async () => {
    const sessionId = await insertSession(31, 32, "acc", "race");
    const entry = event(sessionId, id("b"), {
      eventType: "pit_entry",
      payload: { previousState: "out", state: "pit-lane" },
    });
    const completion = event(sessionId, id("c"), {
      eventType: "pit_service_completed",
      payload: { durationMs: 20_000, observedActions: ["fuel"], state: "pit-stall" },
    });
    await appendRaceEvents([entry, completion]);
    await upsertSessionResult({
      sessionId,
      processorVersion: RACE_RESULT_PROCESSOR_ID,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 4,
      qualifyingPosition: 6,
      isPodium: false,
      isFastestLap: false,
      pitCount: 1,
      eventIds: [entry.eventId, completion.eventId],
      tyreStrategy: null,
      fuelStrategy: { services: [{ addedLitres: 10 }] },
      provenance,
      evidence,
      reasons: [],
    });
    const aggregate = await getRaceResultAggregate({ gameId: "acc", carOrdinal: 31, trackOrdinal: 32 });
    expect(aggregate.pitStops).toBe(1);
    expect(aggregate.pitDurationSeconds).toBe(20);
  });

  test("stale-result queries use the timeline processor version", async () => {
    const sessionId = await insertSession(41, 42, "iracing", "race");
    expect(await getStaleRaceResultSessionIds(RACE_RESULT_PROCESSOR_ID)).toContain(sessionId);
    expect(await countStaleRaceResults(RACE_RESULT_PROCESSOR_ID)).toBeGreaterThan(0);
  });
});
