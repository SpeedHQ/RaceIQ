import { describe, expect, test } from "bun:test";
import type { RaceEventId } from "../../shared/racing/events/contracts";

import {
  SESSION_RUN_ALGORITHM_VERSION,
  SESSION_RUN_SCHEMA_VERSION,
  SessionRunBoundarySchema,
  SessionRunQuerySchema,
  SessionRunSchema,
  SessionRunSummarySchema,
  SessionRunsCompletedMessageSchema,
  type SessionRun,
  type SessionRunEvidence,
  type SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import {
  sessionRunContentHash,
  sessionRunId,
} from "../../server/session-runs/identity";

const openingEventId = `race-event:sha256:${"a".repeat(64)}` as RaceEventId;
const closingEventId = `race-event:sha256:${"b".repeat(64)}` as RaceEventId;
const lapEventId = `race-event:sha256:${"c".repeat(64)}` as RaceEventId;

const falloffEligibility = {
  status: "unknown" as const,
  policyId: "stint-falloff" as const,
  policyVersion: "1",
  confidence: { level: "unknown" as const, score: null },
  reasons: [],
  evidenceIds: [],
};

function summary() {
  return {
    membershipCount: 1,
    completedLapCount: 1,
    validLapCount: 1,
    normalPaceLapCount: 0,
    cautionLapCount: 0,
    outLapCount: 0,
    inLapCount: 0,
    pitLapCount: 0,
    trafficLapCount: 0,
    incidentLapCount: 0,
    dataQualityExcludedLapCount: 1,
    bestLapTimeS: null,
    medianLapTimeS: null,
    meanLapTimeS: null,
    standardDeviationS: null,
    consistency: null,
    degradationSlopeSPerLap: null,
    falloffEligibility,
    qualityLimitations: ["lap_metadata_unavailable"],
  };
}

function run(overrides: Record<string, unknown> = {}) {
  const runId = sessionRunId({
    sessionId: 12,
    participantId: "local-player",
    runKind: "pace",
    timelineEpoch: 0,
    openingEventId,
  });
  return {
    runId,
    schemaVersion: SESSION_RUN_SCHEMA_VERSION,
    algorithmVersion: SESSION_RUN_ALGORITHM_VERSION,
    sessionId: 12,
    participantId: "local-player",
    participantKind: "player",
    driverId: "driver-1",
    teamId: null,
    classId: null,
    runKind: "pace",
    status: "complete",
    openingPhase: "green",
    observedPhases: ["green"],
    timelineEpoch: 0,
    openingSequence: 8,
    openingEventOrder: 30,
    openingBoundary: {
      reason: "participant_joined",
      eventId: openingEventId,
      confidence: "high",
      evidenceKind: "observed",
      algorithmVersion: SESSION_RUN_ALGORITHM_VERSION,
    },
    closingBoundary: {
      reason: "fuel_service",
      eventId: closingEventId,
      confidence: "high",
      evidenceKind: "observed",
      algorithmVersion: SESSION_RUN_ALGORITHM_VERSION,
    },
    startLapEventId: lapEventId,
    endLapEventId: lapEventId,
    startLapId: 90,
    endLapId: 90,
    startSourceTimeMs: 1_000,
    endSourceTimeMs: 91_000,
    startTrackDistanceM: 0,
    endTrackDistanceM: 5_000,
    startTrackDistancePct: 0,
    endTrackDistancePct: 1,
    tireCompound: null,
    tireSetId: null,
    sourceGeneration: "source-1",
    analysisGenerationId: null,
    qualityFlags: ["lap_metadata_unavailable"],
    summary: summary(),
    contentHash: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("session run contracts", () => {
  test("validates persisted runs and websocket messages strictly", () => {
    const parsed = SessionRunSchema.parse(run());
    expect(parsed.runId).toStartWith("session-run:sha256:");
    expect(
      SessionRunsCompletedMessageSchema.parse({
        type: "session-runs-completed",
        sessionId: 12,
        runs: [parsed],
      }).runs,
    ).toHaveLength(1);
    expect(SessionRunSchema.safeParse({ ...run(), extra: true }).success).toBe(
      false,
    );
  });

  test("rejects malformed identities, boundaries, summaries, and ranges", () => {
    expect(
      SessionRunSchema.safeParse({ ...run(), runId: "session-run:bad" }).success,
    ).toBe(false);
    expect(
      SessionRunBoundarySchema.safeParse({
        ...run().openingBoundary,
        eventId: null,
      }).success,
    ).toBe(false);
    expect(
      SessionRunSummarySchema.safeParse({
        ...summary(),
        meanLapTimeS: undefined,
      }).success,
    ).toBe(false);
    expect(
      SessionRunQuerySchema.safeParse({
        minCompletedLaps: "5",
        maxCompletedLaps: "4",
      }).success,
    ).toBe(false);
  });

  test("requires null metrics to carry explicit limitations", () => {
    const parsed = SessionRunSummarySchema.parse(summary());
    expect(parsed.meanLapTimeS).toBeNull();
    expect(parsed.qualityLimitations).toContain("lap_metadata_unavailable");
  });

  test("keeps semantic identity and content stable across persistence metadata", () => {
    const first = SessionRunSchema.parse(run());
    const memberships: SessionRunLapMembership[] = [
      {
        runId: first.runId,
        lapEventId,
        lapId: 90,
        lapNumber: 4,
        ordinal: 0,
        entryEventId: openingEventId,
        exitEventId: closingEventId,
      },
    ];
    const evidence: SessionRunEvidence[] = [
      { runId: first.runId, eventId: openingEventId, role: "opening" },
      { runId: first.runId, eventId: closingEventId, role: "service" },
    ];
    const firstHash = sessionRunContentHash({
      run: first as Omit<SessionRun, "contentHash" | "createdAt">,
      memberships,
      evidence,
    });
    const second = SessionRunSchema.parse(
      run({
        startLapId: 101,
        endLapId: 101,
        sourceGeneration: "source-2",
        analysisGenerationId: "analysis-2",
        openingEventOrder: 99,
        createdAt: "2026-08-19T01:00:00.000Z",
      }),
    );
    const secondHash = sessionRunContentHash({
      run: second as Omit<SessionRun, "contentHash" | "createdAt">,
      memberships: memberships.map((membership) => ({
        ...membership,
        lapId: 101,
      })),
      evidence: [...evidence].reverse(),
    });

    expect(second.runId).toBe(first.runId);
    expect(secondHash).toBe(firstHash);
  });
});
