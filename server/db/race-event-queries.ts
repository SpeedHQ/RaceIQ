import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lte,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import {
  RaceEventIdSchema,
  RaceEventSchema,
  type RaceEvent,
  type RaceEventId,
  type RaceEventPage,
  type RaceEventQuery,
  type RaceEventType,
} from "../../shared/racing/events/contracts";
import {
  SessionRunEvidenceSchema,
  SessionRunLapMembershipSchema,
  SessionRunSchema,
  type SessionRun,
  type SessionRunEvidence,
  type SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";
import {
  appendSessionRunArtifactsInTransaction,
  SessionRunConflictError,
} from "./session-run-queries";
import { db } from "./index";
import {
  compareAnalyses,
  lapAnalyses,
  laps,
  raceEvents,
  sessionRuns,
  sessionResults,
  sessions,
} from "./schema";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;

const SOURCE_QUALITY_EVENT_TYPES = [
  "source_connected",
  "source_disconnected",
  "source_stale",
  "source_recovered",
  "telemetry_gap",
  "out_of_order_input",
  "duplicate_input_suppressed",
  "storage_drop",
  "storage_failure",
  "timeline_discontinuity",
] as const satisfies readonly RaceEventType[];

const TRANSPORT_EVENT_TYPES = [
  "source_connected",
  "source_disconnected",
  "source_stale",
  "source_recovered",
  "storage_drop",
  "storage_failure",
] as const satisfies readonly RaceEventType[];

const PIT_VISIT_EVENT_TYPES = [
  "pit_entry",
  "pit_stall_arrival",
  "pit_service_started",
  "tire_service_observed",
  "fuel_service_observed",
  "repair_service_observed",
  "driver_service_observed",
  "pit_service_completed",
  "pit_stall_departure",
  "pit_exit",
  "pit_visit_incomplete",
  "drive_through_observed",
] as const satisfies readonly RaceEventType[];

type EventCursor = readonly [
  timelineEpoch: number,
  sequence: number,
  eventOrder: number,
  eventId: RaceEventId,
];

export type RaceEventListQuery = Omit<RaceEventQuery, "limit"> & { limit?: number };

export type ReplayableLapReplacement = Omit<
  typeof laps.$inferInsert,
  "id" | "sessionId" | "createdAt" | "lapNumber" | "lapTime"
> & {
  lapNumber: number;
  lapTime: number;
};

export type RaceEventResultProjection = Omit<
  typeof sessionResults.$inferInsert,
  "id" | "sessionId" | "createdAt" | "updatedAt" | "eventIds"
> & {
  eventIds: RaceEventId[];
};

export interface ReplaceReplayableSessionArtifactsInput {
  sessionId: number;
  events: readonly RaceEvent[];
  runs: readonly SessionRun[];
  memberships: readonly SessionRunLapMembership[];
  evidence: readonly SessionRunEvidence[];
  /** Undefined preserves laps; an empty array deliberately removes them all. */
  laps?: readonly ReplayableLapReplacement[];
  /** Undefined preserves the materialized result. */
  result?: RaceEventResultProjection;
}

export interface ReplaceReplayableSessionArtifactsResult {
  events: RaceEvent[];
  runs: SessionRun[];
  memberships: SessionRunLapMembership[];
  evidence: SessionRunEvidence[];
  lapIdsByNumber: Map<number, number>;
  conflictCount: number;
}

export class RaceEventConflictError extends Error {
  readonly eventId: RaceEventId;
  readonly existingContentHash: string | null;
  readonly incomingContentHash: string | null;

  constructor(existing: RaceEvent, incoming: RaceEvent) {
    super(`Race event ${incoming.eventId} conflicts with persisted semantic content`);
    this.name = "RaceEventConflictError";
    this.eventId = incoming.eventId;
    this.existingContentHash = existing.contentHash;
    this.incomingContentHash = incoming.contentHash;
  }
}

export class RaceEventCursorError extends Error {
  constructor() {
    super("Invalid race-event cursor");
    this.name = "RaceEventCursorError";
  }
}

function eventOrderTuple(event: Pick<RaceEvent, "timelineEpoch" | "sequence" | "eventOrder" | "eventId">): EventCursor {
  return [event.timelineEpoch, event.sequence, event.eventOrder, event.eventId];
}

function compareEventOrder(a: EventCursor, b: EventCursor): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): EventCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      !Number.isSafeInteger(value[2]) ||
      value[2] < 0 ||
      !RaceEventIdSchema.safeParse(value[3]).success
    ) {
      throw new RaceEventCursorError();
    }
    return value as unknown as EventCursor;
  } catch (error) {
    if (error instanceof RaceEventCursorError) throw error;
    throw new RaceEventCursorError();
  }
}

export function parseRaceEventRow(row: typeof raceEvents.$inferSelect): RaceEvent {
  return RaceEventSchema.parse(row);
}

function validateEvents(events: readonly RaceEvent[]): RaceEvent[] {
  return events.map((event) => RaceEventSchema.parse(event));
}

function deduplicateEvents(events: readonly RaceEvent[]): RaceEvent[] {
  const unique = new Map<RaceEventId, RaceEvent>();
  for (const event of events) {
    const previous = unique.get(event.eventId);
    if (!previous) {
      unique.set(event.eventId, event);
      continue;
    }
    if (previous.contentHash !== event.contentHash) {
      throw new RaceEventConflictError(previous, event);
    }
  }
  return [...unique.values()].sort((a, b) => compareEventOrder(eventOrderTuple(a), eventOrderTuple(b)));
}

async function insertRaceEventRows(tx: DbTransaction, events: readonly RaceEvent[]): Promise<void> {
  const chunkSize = 250;
  for (let offset = 0; offset < events.length; offset += chunkSize) {
    const chunk = events.slice(offset, offset + chunkSize);
    await tx
      .insert(raceEvents)
      .values(chunk.map((event) => ({ ...event, linkedEventId: null })))
      .run();
  }
  for (const event of events) {
    if (event.linkedEventId == null) continue;
    await tx
      .update(raceEvents)
      .set({ linkedEventId: event.linkedEventId })
      .where(eq(raceEvents.eventId, event.eventId))
      .run();
  }
}

async function assertSessionOwnership(tx: DbTransaction, events: readonly RaceEvent[]): Promise<void> {
  if (events.length === 0) return;
  const sessionIds = [...new Set(events.map((event) => event.sessionId))];
  const persistedSessions = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
    .all();
  if (persistedSessions.length !== sessionIds.length) {
    throw new Error("Race events reference a session that does not exist");
  }

  const eventSessions = new Map(events.map((event) => [event.eventId, event.sessionId]));
  const eventIds = new Set(eventSessions.keys());
  for (const event of events) {
    if (
      event.linkedEventId != null &&
      eventSessions.has(event.linkedEventId) &&
      eventSessions.get(event.linkedEventId) !== event.sessionId
    ) {
      throw new Error(`Race event ${event.eventId} has a cross-session linked event`);
    }
  }
  const lapIds = [...new Set(events.flatMap((event) => (event.lapId == null ? [] : [event.lapId])))];
  if (lapIds.length > 0) {
    const lapRows = await tx
      .select({ id: laps.id, sessionId: laps.sessionId })
      .from(laps)
      .where(inArray(laps.id, lapIds))
      .all();
    const lapSession = new Map(lapRows.map((lap) => [lap.id, lap.sessionId]));
    for (const event of events) {
      if (event.lapId != null && lapSession.get(event.lapId) !== event.sessionId) {
        throw new Error(`Race event ${event.eventId} references a lap outside its session`);
      }
    }
  }

  const externalLinkedIds = [
    ...new Set(
      events.flatMap((event) =>
        event.linkedEventId != null && !eventIds.has(event.linkedEventId) ? [event.linkedEventId] : [],
      ),
    ),
  ];
  if (externalLinkedIds.length > 0) {
    const linkedRows = await tx
      .select({ eventId: raceEvents.eventId, sessionId: raceEvents.sessionId })
      .from(raceEvents)
      .where(inArray(raceEvents.eventId, externalLinkedIds))
      .all();
    const linkedSessions = new Map(linkedRows.map((event) => [event.eventId, event.sessionId]));
    for (const event of events) {
      if (
        event.linkedEventId != null &&
        !eventIds.has(event.linkedEventId) &&
        linkedSessions.get(event.linkedEventId) !== event.sessionId
      ) {
        throw new Error(`Race event ${event.eventId} has a missing or cross-session linked event`);
      }
    }
  }
}

async function applyPitPhaseProjection(tx: DbTransaction, events: readonly RaceEvent[]): Promise<void> {
  const bySessionAndLap = new Map<string, { sessionId: number; lapNumber: number }>();
  for (const event of events) {
    if ((event.eventType !== "pit_entry" && event.eventType !== "pit_exit") || event.lapNumber == null) continue;
    const key = `${event.sessionId}:${event.lapNumber}`;
    bySessionAndLap.set(key, { sessionId: event.sessionId, lapNumber: event.lapNumber });
  }
  if (bySessionAndLap.size === 0) return;

  const affectedLapIds: number[] = [];
  for (const { sessionId, lapNumber } of bySessionAndLap.values()) {
    const pitTransitions = await tx
      .select({ eventType: raceEvents.eventType })
      .from(raceEvents)
      .where(
        and(
          eq(raceEvents.sessionId, sessionId),
          eq(raceEvents.lapNumber, lapNumber),
          inArray(raceEvents.eventType, ["pit_entry", "pit_exit"]),
        ),
      )
      .all();
    const hasEntry = pitTransitions.some(({ eventType }) => eventType === "pit_entry");
    const hasExit = pitTransitions.some(({ eventType }) => eventType === "pit_exit");
    const phase = hasEntry && hasExit ? "pit" : hasEntry ? "in" : "out";
    const updated = await tx
      .update(laps)
      .set({ phase, paceEligibility: "excluded" })
      .where(and(eq(laps.sessionId, sessionId), eq(laps.lapNumber, lapNumber)))
      .returning({ id: laps.id })
      .all();
    affectedLapIds.push(...updated.map(({ id }) => id));
  }
  if (affectedLapIds.length === 0) return;

  const affected = await tx
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      phase: laps.phase,
      conditions: laps.conditions,
      paceEligibility: laps.paceEligibility,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      quality: laps.quality,
    })
    .from(laps)
    .where(inArray(laps.id, affectedLapIds))
    .all();
  const affectedSessionIds = [...new Set(affected.map((lap) => lap.sessionId))];
  const sessionRows = await tx
    .select({
      id: sessions.id,
      recordingQuality: sessions.recordingQuality,
      qualityGeneration: sessions.qualityGeneration,
    })
    .from(sessions)
    .where(inArray(sessions.id, affectedSessionIds))
    .all();
  const sourceGenerationBySession = new Map(
    sessionRows.map((session) => [
      session.id,
      session.recordingQuality?.provenance.sourceGeneration ?? session.qualityGeneration ?? "legacy",
    ]),
  );

  for (const lap of affected) {
    if (!lap.quality) continue;
    const generated = finalizeLapQualityGeneration(
      {
        ...lap.quality,
        classification: {
          phase: lap.phase,
          conditions: lap.conditions,
          paceEligibility: lap.paceEligibility,
        },
      },
      sourceGenerationBySession.get(lap.sessionId) ?? "legacy",
      {
        lapNumber: lap.lapNumber,
        rawByteOffset: lap.rawByteOffset,
        rawFrameCount: lap.rawFrameCount ?? 0,
      },
    );
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
  }

  const uniqueAffectedLapIds = [...new Set(affectedLapIds)];
  await tx.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, uniqueAffectedLapIds)).run();
  await tx
    .delete(compareAnalyses)
    .where(
      or(
        inArray(compareAnalyses.lapAId, uniqueAffectedLapIds),
        inArray(compareAnalyses.lapBId, uniqueAffectedLapIds),
      ),
    )
    .run();
}

async function appendRaceEventsInTransaction(
  tx: DbTransaction,
  input: readonly RaceEvent[],
): Promise<RaceEvent[]> {
  const events = deduplicateEvents(validateEvents(input));
  if (events.length === 0) return [];
  await assertSessionOwnership(tx, events);

  const existingRows = await tx
    .select()
    .from(raceEvents)
    .where(inArray(raceEvents.eventId, events.map((event) => event.eventId)))
    .all();
  const existingById = new Map(existingRows.map((row) => {
    const event = parseRaceEventRow(row);
    return [event.eventId, event] as const;
  }));
  const inserted: RaceEvent[] = [];
  for (const event of events) {
    const existing = existingById.get(event.eventId);
    if (!existing) inserted.push(event);
    else if (existing.contentHash !== event.contentHash) throw new RaceEventConflictError(existing, event);
  }
  if (inserted.length === 0) return [];

  await insertRaceEventRows(tx, inserted);
  await applyPitPhaseProjection(tx, inserted);
  const rows = await tx
    .select()
    .from(raceEvents)
    .where(inArray(raceEvents.eventId, inserted.map((event) => event.eventId)))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  return rows.map(parseRaceEventRow);
}

/**
 * Atomically appends previously unseen semantic events. Passing a transaction
 * participates in the caller's commit; without one, publication-safe rows are
 * returned only after the local transaction commits.
 */
export function appendRaceEvents(
  events: readonly RaceEvent[],
  transaction?: DbTransaction,
): Promise<RaceEvent[]> {
  if (transaction) return appendRaceEventsInTransaction(transaction, events);
  return db.transaction((tx) => appendRaceEventsInTransaction(tx, events));
}

function assertReplacementOrder(events: readonly RaceEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    if (compareEventOrder(eventOrderTuple(events[index - 1]!), eventOrderTuple(events[index]!)) > 0) {
      throw new Error("Replayable race events must be supplied in canonical order");
    }
  }
}

function assertReplacementLaps(lapRows: readonly ReplayableLapReplacement[] | undefined): void {
  if (lapRows == null) return;
  const lapNumbers = new Set<number>();
  for (const lap of lapRows) {
    if (!Number.isSafeInteger(lap.lapNumber) || lap.lapNumber < 0) {
      throw new Error("Replacement laps require a non-negative integer lap number");
    }
    if (lapNumbers.has(lap.lapNumber)) {
      throw new Error(`Replacement lap number ${lap.lapNumber} is duplicated`);
    }
    lapNumbers.add(lap.lapNumber);
  }
}

function assertProjectedResult(
  result: RaceEventResultProjection | undefined,
  resultingEventIds: ReadonlySet<RaceEventId>,
): void {
  if (!result) return;
  if (new Set(result.eventIds).size !== result.eventIds.length) {
    throw new Error("Materialized race result contains duplicate event ids");
  }
  for (const eventId of result.eventIds) {
    if (!resultingEventIds.has(eventId)) {
      throw new Error(`Materialized race result references missing event ${eventId}`);
    }
  }
}

function validateReplacementRunArtifacts(
  input: ReplaceReplayableSessionArtifactsInput,
  resultingEventIds: ReadonlySet<RaceEventId>,
): {
  runs: SessionRun[];
  memberships: SessionRunLapMembership[];
  evidence: SessionRunEvidence[];
} {
  const runs = input.runs.map((run) => SessionRunSchema.parse(run));
  const memberships = input.memberships.map((membership) =>
    SessionRunLapMembershipSchema.parse(membership),
  );
  const evidence = input.evidence.map((item) =>
    SessionRunEvidenceSchema.parse(item),
  );
  const runById = new Map(runs.map((run) => [run.runId, run] as const));
  if (runById.size !== runs.length) {
    throw new Error("Replacement session runs contain duplicate run ids");
  }
  for (const run of runs) {
    if (run.sessionId !== input.sessionId) {
      throw new Error(`Session run ${run.runId} does not belong to replacement session`);
    }
    for (const eventId of [
      run.openingBoundary.eventId,
      run.closingBoundary.eventId,
      run.startLapEventId,
      run.endLapEventId,
    ]) {
      if (eventId && !resultingEventIds.has(eventId)) {
        throw new Error(`Session run ${run.runId} references missing event ${eventId}`);
      }
    }
  }
  const membershipKeys = new Set<string>();
  for (const membership of memberships) {
    if (!runById.has(membership.runId)) {
      throw new Error(`Session run membership references missing run ${membership.runId}`);
    }
    const key = `${membership.runId}:${membership.lapEventId}`;
    if (membershipKeys.has(key)) {
      throw new Error(`Replacement session run membership ${key} is duplicated`);
    }
    membershipKeys.add(key);
    for (const eventId of [
      membership.lapEventId,
      membership.entryEventId,
      membership.exitEventId,
    ]) {
      if (eventId && !resultingEventIds.has(eventId)) {
        throw new Error(`Session run membership references missing event ${eventId}`);
      }
    }
  }
  const evidenceKeys = new Set<string>();
  for (const item of evidence) {
    if (!runById.has(item.runId)) {
      throw new Error(`Session run evidence references missing run ${item.runId}`);
    }
    if (!resultingEventIds.has(item.eventId)) {
      throw new Error(`Session run evidence references missing event ${item.eventId}`);
    }
    const key = `${item.runId}:${item.eventId}:${item.role}`;
    if (evidenceKeys.has(key)) {
      throw new Error(`Replacement session run evidence ${key} is duplicated`);
    }
    evidenceKeys.add(key);
  }
  return { runs, memberships, evidence };
}


async function replaceReplayableSessionArtifactsInTransaction(
  tx: DbTransaction,
  input: ReplaceReplayableSessionArtifactsInput,
  events: readonly RaceEvent[],
): Promise<ReplaceReplayableSessionArtifactsResult> {
  const session = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, input.sessionId)).get();
  if (!session) throw new Error(`Session ${input.sessionId} does not exist`);

  const existingRows = await tx
    .select()
    .from(raceEvents)
    .where(eq(raceEvents.sessionId, input.sessionId))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  const existing = existingRows.map(parseRaceEventRow);
  const existingById = new Map(existing.map((event) => [event.eventId, event]));
  const retained = existing.filter((event) => TRANSPORT_EVENT_TYPES.includes(event.eventType as (typeof TRANSPORT_EVENT_TYPES)[number]));
  const retainedById = new Map(retained.map((event) => [event.eventId, event]));
  let conflictCount = 0;

  for (const event of events) {
    if (event.sessionId !== input.sessionId) {
      throw new Error(`Race event ${event.eventId} does not belong to replacement session`);
    }
    if (event.detectorVersion !== "legacy" && event.detectorVersion !== "legacy-v1" && !event.contentHash) {
      throw new Error(`Replayable race event ${event.eventId} is missing its semantic content hash`);
    }
    const previous = existingById.get(event.eventId);
    if (!previous || previous.contentHash === event.contentHash) continue;
    if (retainedById.has(event.eventId) || previous.detectorVersion === event.detectorVersion) {
      throw new RaceEventConflictError(previous, event);
    }
    conflictCount += 1;
  }

  const proposedById = new Map(events.map((event) => [event.eventId, event]));
  for (const event of events) {
    if (event.linkedEventId == null) continue;
    const target = proposedById.get(event.linkedEventId) ?? retainedById.get(event.linkedEventId);
    if (!target || target.sessionId !== input.sessionId) {
      throw new Error(`Race event ${event.eventId} has a missing or cross-session linked event`);
    }
  }
  const resultingEventIds = new Set<RaceEventId>([
    ...retained.map((event) => event.eventId),
    ...events.map((event) => event.eventId),
  ]);
  assertProjectedResult(input.result, resultingEventIds);
  const runArtifacts = validateReplacementRunArtifacts(input, resultingEventIds);
  const existingRunRows = await tx
    .select({
      runId: sessionRuns.runId,
      algorithmVersion: sessionRuns.algorithmVersion,
      contentHash: sessionRuns.contentHash,
    })
    .from(sessionRuns)
    .where(eq(sessionRuns.sessionId, input.sessionId))
    .all();
  const existingRunById = new Map(
    existingRunRows.map((row) => [row.runId, row] as const),
  );
  for (const run of runArtifacts.runs) {
    const previous = existingRunById.get(run.runId);
    if (!previous || previous.contentHash === run.contentHash) continue;
    if (previous.algorithmVersion === run.algorithmVersion) {
      throw new SessionRunConflictError(run.runId);
    }
    conflictCount += 1;
  }
  const eventsToInsert = events.filter((event) => !retainedById.has(event.eventId));

  await tx.delete(sessionRuns).where(eq(sessionRuns.sessionId, input.sessionId)).run();

  await tx
    .delete(raceEvents)
    .where(
      and(
        eq(raceEvents.sessionId, input.sessionId),
        notInArray(raceEvents.eventType, [...TRANSPORT_EVENT_TYPES]),
      ),
    )
    .run();

  const lapIdsByNumber = new Map<number, number>();
  if (input.laps !== undefined) {
    const oldLaps = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, input.sessionId)).all();
    const oldLapIds = oldLaps.map(({ id }) => id);
    if (oldLapIds.length > 0) {
      await tx
        .delete(compareAnalyses)
        .where(or(inArray(compareAnalyses.lapAId, oldLapIds), inArray(compareAnalyses.lapBId, oldLapIds)))
        .run();
      await tx.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, oldLapIds)).run();
    }
    await tx.delete(laps).where(eq(laps.sessionId, input.sessionId)).run();
    for (const replacement of input.laps) {
      const inserted = await tx
        .insert(laps)
        .values({ ...replacement, sessionId: input.sessionId })
        .returning({ id: laps.id, lapNumber: laps.lapNumber })
        .get();
      lapIdsByNumber.set(inserted.lapNumber, inserted.id);
    }
    for (const [lapNumber, lapId] of lapIdsByNumber) {
      await tx
        .update(raceEvents)
        .set({ lapId })
        .where(
          and(
            eq(raceEvents.sessionId, input.sessionId),
            eq(raceEvents.lapNumber, lapNumber),
            inArray(raceEvents.eventType, [...TRANSPORT_EVENT_TYPES]),
          ),
        )
        .run();
    }
  }

  const remappedEvents = eventsToInsert.map((event) => {
    if (input.laps === undefined) return event;
    return {
      ...event,
      lapId: event.lapNumber == null ? null : lapIdsByNumber.get(event.lapNumber) ?? null,
    };
  });
  await assertSessionOwnership(tx, remappedEvents);
  if (remappedEvents.length > 0) await insertRaceEventRows(tx, remappedEvents);
  await applyPitPhaseProjection(tx, remappedEvents);


  const remappedMemberships = runArtifacts.memberships.map((membership) => ({
    ...membership,
    lapId:
      input.laps === undefined
        ? membership.lapId
        : (lapIdsByNumber.get(membership.lapNumber) ?? null),
  }));
  const lapIdByEventId = new Map(
    remappedMemberships.map((membership) => [
      membership.lapEventId,
      membership.lapId,
    ] as const),
  );
  const remappedRuns = runArtifacts.runs.map((run) => ({
    ...run,
    startLapId:
      run.startLapEventId == null
        ? null
        : (lapIdByEventId.get(run.startLapEventId) ?? null),
    endLapId:
      run.endLapEventId == null
        ? null
        : (lapIdByEventId.get(run.endLapEventId) ?? null),
  }));
  const insertedRuns = await appendSessionRunArtifactsInTransaction(
    tx,
    {
      runs: remappedRuns,
      memberships: remappedMemberships,
      evidence: runArtifacts.evidence,
    },
  );
  if (input.result) {
    const now = new Date().toISOString();
    const existingResult = await tx
      .select({ id: sessionResults.id })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, input.sessionId))
      .get();
    const values = { ...input.result, sessionId: input.sessionId, updatedAt: now };
    if (existingResult) {
      await tx.update(sessionResults).set(values).where(eq(sessionResults.id, existingResult.id)).run();
    } else {
      await tx.insert(sessionResults).values(values).run();
    }
  }

  const persistedRows = events.length === 0
    ? []
    : await tx
        .select()
        .from(raceEvents)
        .where(inArray(raceEvents.eventId, events.map((event) => event.eventId)))
        .orderBy(
          asc(raceEvents.timelineEpoch),
          asc(raceEvents.sequence),
          asc(raceEvents.eventOrder),
          asc(raceEvents.eventId),
        )
        .all();
  return {
    events: persistedRows.map(parseRaceEventRow),
    runs: insertedRuns,
    memberships: remappedMemberships,
    evidence: runArtifacts.evidence,
    lapIdsByNumber,
    conflictCount,
  };
}

/**
 * Atomically activates one complete replayable generation. Transport lifecycle
 * and storage diagnostics survive replacement; every other timeline fact is
 * validated before destructive work starts and replaced in one transaction.
 */
export function replaceReplayableSessionArtifacts(
  input: ReplaceReplayableSessionArtifactsInput,
  transaction?: DbTransaction,
): Promise<ReplaceReplayableSessionArtifactsResult> {
  const validatedEvents = validateEvents(input.events);
  assertReplacementOrder(validatedEvents);
  const events = deduplicateEvents(validatedEvents);
  assertReplacementLaps(input.laps);
  if (transaction) {
    return replaceReplayableSessionArtifactsInTransaction(
      transaction,
      input,
      events,
    );
  }
  return db.transaction((tx) =>
    replaceReplayableSessionArtifactsInTransaction(tx, input, events),
  );
}

async function finalizeRaceEventSourceGenerationInTransaction(
  tx: DbTransaction,
  sessionId: number,
  sourceGeneration: string,
): Promise<number> {
  if (sourceGeneration.length === 0 || sourceGeneration.startsWith("provisional:")) {
    throw new Error("Final race-event source generation must be verified and non-provisional");
  }
  const result = await tx
    .update(raceEvents)
    .set({ sourceGeneration })
    .where(
      and(
        eq(raceEvents.sessionId, sessionId),
        or(isNull(raceEvents.sourceGeneration), like(raceEvents.sourceGeneration, "provisional:%")),
      ),
    )
    .run();
  return Number(result.rowsAffected ?? 0);
}

export function finalizeRaceEventSourceGeneration(
  sessionId: number,
  sourceGeneration: string,
  transaction?: DbTransaction,
): Promise<number> {
  if (transaction) return finalizeRaceEventSourceGenerationInTransaction(transaction, sessionId, sourceGeneration);
  return db.transaction((tx) => finalizeRaceEventSourceGenerationInTransaction(tx, sessionId, sourceGeneration));
}

async function attachRaceEventsToLapInTransaction(
  tx: DbTransaction,
  sessionId: number,
  lapNumber: number,
  lapId: number,
): Promise<RaceEvent[]> {
  const [lap] = await tx
    .select({ id: laps.id })
    .from(laps)
    .where(and(eq(laps.id, lapId), eq(laps.sessionId, sessionId), eq(laps.lapNumber, lapNumber)))
    .all();
  if (!lap) throw new Error(`Lap ${lapId} is not lap ${lapNumber} in session ${sessionId}`);
  await tx
    .update(raceEvents)
    .set({ lapId })
    .where(and(eq(raceEvents.sessionId, sessionId), eq(raceEvents.lapNumber, lapNumber)))
    .run();
  const rows = await tx
    .select()
    .from(raceEvents)
    .where(and(eq(raceEvents.sessionId, sessionId), eq(raceEvents.lapNumber, lapNumber)))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  return rows.map(parseRaceEventRow);
}

export function attachRaceEventsToLap(
  sessionId: number,
  lapNumber: number,
  lapId: number,
  transaction?: DbTransaction,
): Promise<RaceEvent[]> {
  if (transaction) return attachRaceEventsToLapInTransaction(transaction, sessionId, lapNumber, lapId);
  return db.transaction((tx) => attachRaceEventsToLapInTransaction(tx, sessionId, lapNumber, lapId));
}

function cursorCondition(cursor: EventCursor): SQL {
  return or(
    gt(raceEvents.timelineEpoch, cursor[0]),
    and(eq(raceEvents.timelineEpoch, cursor[0]), gt(raceEvents.sequence, cursor[1])),
    and(
      eq(raceEvents.timelineEpoch, cursor[0]),
      eq(raceEvents.sequence, cursor[1]),
      gt(raceEvents.eventOrder, cursor[2]),
    ),
    and(
      eq(raceEvents.timelineEpoch, cursor[0]),
      eq(raceEvents.sequence, cursor[1]),
      eq(raceEvents.eventOrder, cursor[2]),
      gt(raceEvents.eventId, cursor[3]),
    ),
  )!;
}

function listConditions(sessionId: number, query: RaceEventListQuery): SQL[] {
  const conditions: SQL[] = [eq(raceEvents.sessionId, sessionId)];
  if (query.participantId !== undefined) conditions.push(eq(raceEvents.participantId, query.participantId));
  if (query.lapNumber !== undefined) conditions.push(eq(raceEvents.lapNumber, query.lapNumber));
  if (query.fromSourceTimeMs !== undefined) conditions.push(gte(raceEvents.sourceEndTimeMs, query.fromSourceTimeMs));
  if (query.toSourceTimeMs !== undefined) conditions.push(lte(raceEvents.sourceTimeMs, query.toSourceTimeMs));
  if (query.eventType !== undefined) conditions.push(eq(raceEvents.eventType, query.eventType));
  if (query.lifecycleId !== undefined) conditions.push(eq(raceEvents.lifecycleId, query.lifecycleId));
  if (query.qualityOnly) conditions.push(inArray(raceEvents.eventType, [...SOURCE_QUALITY_EVENT_TYPES]));
  if (query.cursor !== undefined) conditions.push(cursorCondition(decodeCursor(query.cursor)));
  return conditions;
}

export async function listSessionRaceEvents(
  sessionId: number,
  query: RaceEventListQuery = {},
): Promise<RaceEventPage> {
  const requestedLimit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PAGE_LIMIT) {
    throw new RangeError(`Race-event page limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  const rows = await db
    .select()
    .from(raceEvents)
    .where(and(...listConditions(sessionId, query)))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .limit(requestedLimit + 1)
    .all();
  const hasNextPage = rows.length > requestedLimit;
  const pageRows = hasNextPage ? rows.slice(0, requestedLimit) : rows;
  const items = pageRows.map(parseRaceEventRow);
  return {
    items,
    nextCursor: hasNextPage && items.length > 0 ? encodeCursor(eventOrderTuple(items[items.length - 1]!)) : null,
  };
}

export async function listRaceEventsForLap(lapId: number): Promise<RaceEvent[]> {
  const rows = await db
    .select({ event: raceEvents })
    .from(raceEvents)
    .innerJoin(laps, eq(raceEvents.lapId, laps.id))
    .where(eq(laps.id, lapId))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  return rows.map(({ event }) => parseRaceEventRow(event));
}

export async function listRaceEventsForLifecycle(
  sessionId: number,
  lifecycleId: string,
): Promise<RaceEvent[]> {
  const rows = await db
    .select()
    .from(raceEvents)
    .where(and(eq(raceEvents.sessionId, sessionId), eq(raceEvents.lifecycleId, lifecycleId)))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  return rows.map(parseRaceEventRow);
}

export async function listPitVisitRaceEvents(
  sessionId: number,
  lifecycleId: string,
): Promise<RaceEvent[]> {
  const rows = await db
    .select()
    .from(raceEvents)
    .where(
      and(
        eq(raceEvents.sessionId, sessionId),
        eq(raceEvents.lifecycleId, lifecycleId),
        inArray(raceEvents.eventType, [...PIT_VISIT_EVENT_TYPES]),
      ),
    )
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  return rows.map(parseRaceEventRow);
}
