import { beforeEach, describe, expect, test } from "bun:test";

import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import { db } from "../../server/db";
import {
  appendSessionRunArtifacts,
  listSessionRunEvidence,
  listSessionRunLaps,
  listSessionRuns,
  SessionRunConflictError,
} from "../../server/db/session-run-queries";
import { appendRaceEvents } from "../../server/db/race-event-queries";
import {
  laps,
  raceEvents,
  sessionRunEvidence,
  sessionRunLaps,
  sessionRuns,
  sessions,
} from "../../server/db/schema";
import { SessionRunBuilder } from "../../server/session-runs/builder";

function eventId(value: number): RaceEventId {
  return `race-event:sha256:${value.toString(16).padStart(64, "0")}` as RaceEventId;
}

function event(
  value: number,
  eventType: RaceEvent["eventType"],
  payload: RaceEvent["payload"],
  overrides: Partial<RaceEvent> = {},
): RaceEvent {
  return {
    eventId: eventId(value),
    eventType,
    schemaVersion: "race-event-v1",
    sessionId: 1,
    participantId: "car-1",
    participantKind: "player",
    driverId: "driver-1",
    teamId: null,
    timelineEpoch: 0,
    sequence: value,
    eventOrder: 20,
    sourceTimeMs: value * 1_000,
    sourceEndTimeMs: value * 1_000,
    sourceSequenceFamily: "test",
    sourceSequence: value,
    receivedAtMs: value * 1_000,
    lapNumber: null,
    lapId: null,
    trackDistanceM: value * 100,
    trackDistancePct: 0.2,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload,
    lifecycleId: null,
    linkedEventId: null,
    detectorId: "session-run-query-test",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: `sha256:${value.toString(16).padStart(64, "0")}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  } as RaceEvent;
}

beforeEach(async () => {
  await db.delete(sessionRunEvidence);
  await db.delete(sessionRunLaps);
  await db.delete(sessionRuns);
  await db.delete(raceEvents);
  await db.delete(laps);
  await db.delete(sessions);
  await db.insert(sessions).values({
    id: 1,
    carOrdinal: 10,
    trackOrdinal: 20,
    gameId: "iracing",
  });
});

async function seedRuns() {
  const lapRows = await db
    .insert(laps)
    .values({
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90,
      isValid: true,
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    })
    .returning({ id: laps.id });
  const lapId = lapRows[0]!.id;
  const joined = event(1, "participant_joined", {
    sourceId: "car-1",
    identityState: "stable",
    displayName: "Driver",
    vehicleId: "car",
  });
  const completed = event(
    2,
    "lap_completed",
    {
      lapNumber: 1,
      lapTimeMs: 90_000,
      isValid: true,
      phase: "flying",
      conditions: [],
    },
    { lapNumber: 1, lapId },
  );
  const ended = event(
    3,
    "session_ended",
    {
      phase: "finished",
      previousPhase: "green",
      reason: "complete",
      terminalObserved: true,
      nativeCode: null,
    },
    { participantId: null, participantKind: null, driverId: null },
  );
  await appendRaceEvents([joined, completed, ended]);
  const builder = new SessionRunBuilder();
  const update = builder.consume({
    events: [joined, completed, ended],
    lapsByCompletionEventId: new Map([
      [
        completed.eventId,
        {
          lapEventId: completed.eventId,
          lapId,
          lapNumber: 1,
          lapTimeMs: 90_000,
          isValid: true,
          phase: "flying",
          conditions: [],
          quality: null,
          eligibility: null,
        },
      ],
    ]),
  });
  await appendSessionRunArtifacts(update);
  update.commit();
  return update;
}

describe("session run persistence", () => {
  test("appends idempotently and pages shared opening coordinates without skips", async () => {
    const update = await seedRuns();
    expect(await appendSessionRunArtifacts(update)).toEqual([]);

    const first = await listSessionRuns(1, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSessionRuns(1, {
      limit: 10,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map(({ runId }) => runId)).size,
    ).toBe(4);
  });

  test("returns semantic memberships, lap metadata, and evidence", async () => {
    await seedRuns();
    const page = await listSessionRuns(1, { runKind: "tire" });
    const run = page.items[0]!;
    const lapPage = await listSessionRunLaps(run.runId);
    expect(lapPage.items).toHaveLength(1);
    expect(lapPage.items[0]!.membership.lapEventId).toBe(eventId(2));
    expect(lapPage.items[0]!.lap?.id).toBeGreaterThan(0);
    const evidencePage = await listSessionRunEvidence(run.runId);
    expect(evidencePage.items.map(({ role }) => role)).toContain("opening");
    expect(evidencePage.items.map(({ role }) => role)).toContain("closing");
  });

  test("rejects same-identity semantic conflicts before mutation", async () => {
    const update = await seedRuns();
    const conflict = {
      runs: [{ ...update.runs[0]!, contentHash: `sha256:${"f".repeat(64)}` }],
      memberships: [],
      evidence: [],
    };
    await expect(appendSessionRunArtifacts(conflict)).rejects.toBeInstanceOf(
      SessionRunConflictError,
    );
    expect(await db.select().from(sessionRuns)).toHaveLength(4);
  });

  test("cascades derived run artifacts with session deletion", async () => {
    await seedRuns();
    await db.delete(sessions);
    expect(await db.select().from(sessionRuns)).toHaveLength(0);
    expect(await db.select().from(sessionRunLaps)).toHaveLength(0);
    expect(await db.select().from(sessionRunEvidence)).toHaveLength(0);
  });
});
