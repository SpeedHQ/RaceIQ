import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import { db } from "../../server/db";
import {
  appendSessionRunArtifacts,
  listComparableSessionRuns,
  listSessionRunEvidence,
  listSessionRunLaps,
  listSessionRuns,
  rebuildPersistedSessionRuns,
  SessionRunConflictError,
  SessionRunCursorError,
} from "../../server/db/session-run-queries";
import {
  appendRaceEvents,
  finalizeRaceEventSourceGeneration,
} from "../../server/db/race-event-queries";
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

async function seedComparableSession(
  sessionId: number,
  base: number,
  gameId: "acc" | "f1-2025",
  condition: "slow_zone" | "formation",
) {
  await db.insert(sessions).values({
    id: sessionId,
    carOrdinal: 10,
    trackOrdinal: 20,
    gameId,
  });
  const lapId = (
    await db
      .insert(laps)
      .values({
        sessionId,
        lapNumber: 1,
        lapTime: 90,
        isValid: true,
        phase: "flying",
        conditions: [condition],
        paceEligibility: "excluded",
      })
      .returning({ id: laps.id })
      .get()
  ).id;
  const joined = event(
    base,
    "participant_joined",
    {
      sourceId: `car-${sessionId}`,
      identityState: "stable",
      displayName: "Driver",
      vehicleId: "car",
    },
    { sessionId },
  );
  const completed = event(
    base + 1,
    "lap_completed",
    {
      lapNumber: 1,
      lapTimeMs: 90_000,
      isValid: true,
      phase: "flying",
      conditions: [condition],
    },
    { sessionId, lapNumber: 1, lapId },
  );
  const ended = event(
    base + 2,
    "session_ended",
    {
      phase: "finished",
      previousPhase: "green",
      reason: "complete",
      terminalObserved: true,
      nativeCode: null,
    },
    {
      sessionId,
      participantId: null,
      participantKind: null,
      driverId: null,
    },
  );
  const events = [joined, completed, ended];
  await appendRaceEvents(events);
  const builder = new SessionRunBuilder();
  const update = builder.consume({
    events,
    lapsByCompletionEventId: new Map([
      [
        completed.eventId,
        {
          lapEventId: completed.eventId,
          lapId,
          lapNumber: 1,
          lapTimeMs: 90_000,
          isValid: true,
          phase: "flying" as const,
          conditions: [condition],
          quality: null,
          eligibility: null,
        },
      ],
    ]),
  });
  await appendSessionRunArtifacts(update);
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

  test("uses boundary coordinates for zero-lap overlap segments", async () => {
    const joined = event(10, "participant_joined", {
      sourceId: "car-1",
      identityState: "stable",
      displayName: "Driver",
      vehicleId: "car",
    });
    const lap1 = event(
      11,
      "lap_completed",
      {
        lapNumber: 1,
        lapTimeMs: 90_000,
        isValid: true,
        phase: "flying",
        conditions: [],
      },
      { lapNumber: 1 },
    );
    const fuel1 = event(12, "fuel_service_observed", {
      beforeLitres: 10,
      afterLitres: 20,
      addedLitres: 10,
    });
    const progress = event(13, "position_changed", {
      previousPosition: 3,
      position: 2,
    });
    const fuel2 = event(14, "fuel_service_observed", {
      beforeLitres: 20,
      afterLitres: 30,
      addedLitres: 10,
    });
    const lap2 = event(
      15,
      "lap_completed",
      {
        lapNumber: 2,
        lapTimeMs: 89_000,
        isValid: true,
        phase: "flying",
        conditions: [],
      },
      { lapNumber: 2 },
    );
    const ended = event(
      16,
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
    const events = [joined, lap1, fuel1, progress, fuel2, lap2, ended];
    await appendRaceEvents(events);
    const builder = new SessionRunBuilder();
    const update = builder.consume({
      events,
      lapsByCompletionEventId: {},
    });
    await appendSessionRunArtifacts(update);
    const tire = (await listSessionRuns(1, { runKind: "tire" })).items[0]!;
    const pace = await listSessionRuns(1, {
      runKind: "pace",
      overlapsRunId: tire.runId,
    });
    expect(pace.items).toHaveLength(3);
    expect(
      pace.items.some(({ summary }) => summary.completedLapCount === 0),
    ).toBe(true);
  });

  test("rejects malformed lap membership cursors", async () => {
    await seedRuns();
    const run = (await listSessionRuns(1, { runKind: "tire" })).items[0]!;
    const cursor = Buffer.from(JSON.stringify([0, "garbage"])).toString(
      "base64url",
    );
    await expect(
      listSessionRunLaps(run.runId, { cursor }),
    ).rejects.toBeInstanceOf(SessionRunCursorError);
  });

  test("rebuilds summaries and source generation from finalized rows", async () => {
    await seedRuns();
    await db
      .update(laps)
      .set({ phase: "pit", conditions: [], paceEligibility: "excluded" })
      .where(eq(laps.sessionId, 1));
    const rebuilt = await rebuildPersistedSessionRuns(1);
    expect(rebuilt.every(({ summary }) => summary.pitLapCount === 1)).toBe(
      true,
    );
    await finalizeRaceEventSourceGeneration(1, `sha256:${"e".repeat(64)}`);
    expect(
      (await db.select().from(sessionRuns)).every(
        ({ sourceGeneration }) =>
          sourceGeneration === `sha256:${"e".repeat(64)}`,
      ),
    ).toBe(true);
  });

  test("filters comparable candidates before paging and returns conditions", async () => {
    await seedRuns();
    await seedComparableSession(2, 10, "f1-2025", "slow_zone");
    await seedComparableSession(3, 20, "acc", "formation");
    const reference = (
      await listSessionRuns(1, { runKind: "tire" })
    ).items[0]!;
    const page = await listComparableSessionRuns(reference.runId, {
      gameId: "acc",
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.run.sessionId).toBe(3);
    expect(page.items[0]!.memberConditions).toEqual(["formation"]);
  });
});
