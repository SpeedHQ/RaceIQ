import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ComparableSessionRunPageSchema,
  SessionRunEvidencePageSchema,
  SessionRunEvidenceSchema,
  SessionRunEvidenceRoleSchema,
  SessionRunIdSchema,
  SessionRunLapMembershipSchema,
  SessionRunLapPageSchema,
  SessionRunPageSchema,
  SessionRunSchema,
  type ComparableSessionRunPage,
  type ComparableSessionRunQuery,
  type SessionRun,
  type SessionRunEvidence,
  type SessionRunEvidencePage,
  type SessionRunId,
  type SessionRunLapMembership,
  type SessionRunLapPage,
  type SessionRunLapQuery,
  type SessionRunPage,
  type SessionRunQuery,
} from "../../shared/racing/runs/contracts";
import { resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import {
  RaceEventIdSchema,
  RaceEventSchema,
  type RaceEvent,
  type RaceEventId,
} from "../../shared/racing/events/contracts";
import {
  SessionRunBuilder,
  type PreparedSessionRunUpdate,
} from "../session-runs/builder";
import type { CompletedSessionRunLap } from "../../shared/racing/runs/summary";
import {
  appendRaceEvents,
  attachRaceEventsToLap,
} from "./race-event-queries";
import { db } from "./index";
import {
  laps,
  raceEvents,
  sessionRunEvidence,
  sessionRunLaps,
  sessionRuns,
  sessions,
} from "./schema";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SessionRunListQuery = Omit<SessionRunQuery, "limit"> & {
  limit?: number;
};
export type SessionRunLapListQuery = Partial<
  Omit<SessionRunLapQuery, "limit">
> & {
  limit?: number;
};
export type ComparableSessionRunListQuery = Partial<
  Omit<ComparableSessionRunQuery, "limit">
> & { limit?: number };

export interface RaceEventLapLink {
  sessionId: number;
  lapNumber: number;
  lapId: number;
}

export interface SessionRunArtifacts {
  runs: readonly SessionRun[];
  memberships: readonly SessionRunLapMembership[];
  evidence: readonly SessionRunEvidence[];
}

export interface AppendedSessionRunArtifacts {
  events: RaceEvent[];
  runs: SessionRun[];
}

type RunCursor = readonly [
  timelineEpoch: number,
  openingSequence: number,
  openingEventOrder: number,
  runId: SessionRunId,
];

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;

export class SessionRunConflictError extends Error {
  readonly runId: SessionRunId;

  constructor(runId: SessionRunId) {
    super(`Session run ${runId} conflicts with persisted semantic content`);
    this.name = "SessionRunConflictError";
    this.runId = runId;
  }
}

export class SessionRunCursorError extends Error {
  constructor() {
    super("Invalid session-run cursor");
    this.name = "SessionRunCursorError";
  }
}

export class SessionRunNotFoundError extends Error {
  constructor() {
    super("Session run not found");
    this.name = "SessionRunNotFoundError";
  }
}

function runOrderTuple(
  run: Pick<
    SessionRun,
    "timelineEpoch" | "openingSequence" | "openingEventOrder" | "runId"
  >,
): RunCursor {
  return [
    run.timelineEpoch,
    run.openingSequence,
    run.openingEventOrder,
    run.runId,
  ];
}

function encodeCursor(cursor: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRunCursor(cursor: string): RunCursor {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      !Number.isSafeInteger(value[2]) ||
      value[2] < 0 ||
      !SessionRunIdSchema.safeParse(value[3]).success
    ) {
      throw new SessionRunCursorError();
    }
    return value as unknown as RunCursor;
  } catch (error) {
    if (error instanceof SessionRunCursorError) throw error;
    throw new SessionRunCursorError();
  }
}

function decodePairCursor(cursor: string): readonly [number, RaceEventId] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Number.isSafeInteger(value[0]) ||
      value[0] < 0 ||
      !RaceEventIdSchema.safeParse(value[1]).success
    ) {
      throw new SessionRunCursorError();
    }
    return value as unknown as readonly [number, RaceEventId];
  } catch (error) {
    if (error instanceof SessionRunCursorError) throw error;
    throw new SessionRunCursorError();
  }
}

function decodeEvidenceCursor(
  cursor: string,
): readonly [RaceEventId, SessionRunEvidence["role"]] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !RaceEventIdSchema.safeParse(value[0]).success ||
      !SessionRunEvidenceRoleSchema.safeParse(value[1]).success
    ) {
      throw new SessionRunCursorError();
    }
    return value as unknown as readonly [
      RaceEventId,
      SessionRunEvidence["role"],
    ];
  } catch (error) {
    if (error instanceof SessionRunCursorError) throw error;
    throw new SessionRunCursorError();
  }
}

function requestedLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new RangeError(
      `Session-run page limit must be between 1 and ${MAX_PAGE_LIMIT}`,
    );
  }
  return value;
}

export function parseSessionRunRow(
  row: typeof sessionRuns.$inferSelect,
): SessionRun {
  return SessionRunSchema.parse({
    runId: row.runId,
    schemaVersion: row.schemaVersion,
    algorithmVersion: row.algorithmVersion,
    sessionId: row.sessionId,
    participantId: row.participantId,
    participantKind: row.participantKind,
    driverId: row.driverId,
    teamId: row.teamId,
    classId: row.classId,
    runKind: row.runKind,
    status: row.status,
    openingPhase: row.openingPhase,
    observedPhases: row.observedPhases,
    timelineEpoch: row.timelineEpoch,
    openingSequence: row.openingSequence,
    openingEventOrder: row.openingEventOrder,
    openingBoundary: {
      reason: row.openingReason,
      eventId: row.openingEventId,
      confidence: row.openingConfidence,
      evidenceKind: row.openingEvidenceKind,
      algorithmVersion: row.algorithmVersion,
    },
    closingBoundary: {
      reason: row.closingReason,
      eventId: row.closingEventId,
      confidence: row.closingConfidence,
      evidenceKind: row.closingEvidenceKind,
      algorithmVersion: row.algorithmVersion,
    },
    startLapEventId: row.startLapEventId,
    endLapEventId: row.endLapEventId,
    startLapId: row.startLapId,
    endLapId: row.endLapId,
    startSourceTimeMs: row.startSourceTimeMs,
    endSourceTimeMs: row.endSourceTimeMs,
    startTrackDistanceM: row.startTrackDistanceM,
    endTrackDistanceM: row.endTrackDistanceM,
    startTrackDistancePct: row.startTrackDistancePct,
    endTrackDistancePct: row.endTrackDistancePct,
    tireCompound: row.tireCompound,
    tireSetId: row.tireSetId,
    sourceGeneration: row.sourceGeneration,
    analysisGenerationId: row.analysisGenerationId,
    qualityFlags: row.qualityFlags,
    summary: row.summary,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  });
}

function runInsert(run: SessionRun): typeof sessionRuns.$inferInsert {
  return {
    runId: run.runId,
    schemaVersion: run.schemaVersion,
    algorithmVersion: run.algorithmVersion,
    sessionId: run.sessionId,
    participantId: run.participantId,
    participantKind: run.participantKind,
    driverId: run.driverId,
    teamId: run.teamId,
    classId: run.classId,
    runKind: run.runKind,
    status: run.status,
    openingPhase: run.openingPhase,
    observedPhases: run.observedPhases,
    timelineEpoch: run.timelineEpoch,
    openingSequence: run.openingSequence,
    openingEventOrder: run.openingEventOrder,
    openingReason: run.openingBoundary.reason,
    openingEventId: run.openingBoundary.eventId!,
    openingConfidence: run.openingBoundary.confidence,
    openingEvidenceKind: run.openingBoundary.evidenceKind,
    closingReason: run.closingBoundary.reason,
    closingEventId: run.closingBoundary.eventId,
    closingConfidence: run.closingBoundary.confidence,
    closingEvidenceKind: run.closingBoundary.evidenceKind,
    startLapEventId: run.startLapEventId,
    endLapEventId: run.endLapEventId,
    startLapId: run.startLapId,
    endLapId: run.endLapId,
    startSourceTimeMs: run.startSourceTimeMs,
    endSourceTimeMs: run.endSourceTimeMs,
    startTrackDistanceM: run.startTrackDistanceM,
    endTrackDistanceM: run.endTrackDistanceM,
    startTrackDistancePct: run.startTrackDistancePct,
    endTrackDistancePct: run.endTrackDistancePct,
    tireCompound: run.tireCompound,
    tireSetId: run.tireSetId,
    sourceGeneration: run.sourceGeneration,
    analysisGenerationId: run.analysisGenerationId,
    qualityFlags: run.qualityFlags,
    summary: run.summary,
    contentHash: run.contentHash,
    createdAt: run.createdAt,
  };
}

async function assertArtifactOwnership(
  tx: DbTransaction,
  artifacts: SessionRunArtifacts,
): Promise<void> {
  const runById = new Map(
    artifacts.runs.map((run) => [run.runId, run] as const),
  );
  const existingRunIds = [
    ...new Set(
      [...artifacts.memberships, ...artifacts.evidence]
        .map(({ runId }) => runId)
        .filter((runId) => !runById.has(runId)),
    ),
  ];
  if (existingRunIds.length > 0) {
    const rows = await tx
      .select()
      .from(sessionRuns)
      .where(inArray(sessionRuns.runId, existingRunIds))
      .all();
    for (const row of rows) {
      const run = parseSessionRunRow(row);
      runById.set(run.runId, run);
    }
    if (rows.length !== existingRunIds.length) throw new SessionRunNotFoundError();
  }

  const referencedEventIds = [
    ...new Set(
      artifacts.runs.flatMap((run) => [
        run.openingBoundary.eventId,
        run.closingBoundary.eventId,
        run.startLapEventId,
        run.endLapEventId,
      ]).concat(
        artifacts.memberships.flatMap((membership) => [
          membership.lapEventId,
          membership.entryEventId,
          membership.exitEventId,
        ]),
        artifacts.evidence.map(({ eventId }) => eventId),
      ).filter((eventId): eventId is RaceEventId => eventId !== null),
    ),
  ];
  const eventRows =
    referencedEventIds.length === 0
      ? []
      : await tx
          .select({ eventId: raceEvents.eventId, sessionId: raceEvents.sessionId })
          .from(raceEvents)
          .where(inArray(raceEvents.eventId, referencedEventIds))
          .all();
  if (eventRows.length !== referencedEventIds.length) {
    throw new Error("Session run references an event that does not exist");
  }
  const eventSessionById = new Map(
    eventRows.map((row) => [row.eventId, row.sessionId] as const),
  );
  for (const run of artifacts.runs) {
    for (const eventId of [
      run.openingBoundary.eventId,
      run.closingBoundary.eventId,
      run.startLapEventId,
      run.endLapEventId,
    ]) {
      if (eventId && eventSessionById.get(eventId) !== run.sessionId) {
        throw new Error("Session run event belongs to another session");
      }
    }
  }
  for (const membership of artifacts.memberships) {
    const run = runById.get(membership.runId);
    if (!run) throw new SessionRunNotFoundError();
    for (const eventId of [
      membership.lapEventId,
      membership.entryEventId,
      membership.exitEventId,
    ]) {
      if (eventId && eventSessionById.get(eventId) !== run.sessionId) {
        throw new Error("Session run lap event belongs to another session");
      }
    }
  }
  for (const item of artifacts.evidence) {
    const run = runById.get(item.runId);
    if (!run) throw new SessionRunNotFoundError();
    if (eventSessionById.get(item.eventId) !== run.sessionId) {
      throw new Error("Session run evidence belongs to another session");
    }
  }

  const lapIds = [
    ...new Set(
      artifacts.memberships
        .map(({ lapId }) => lapId)
        .concat(
          artifacts.runs.flatMap((run) => [run.startLapId, run.endLapId]),
        )
        .filter((lapId): lapId is number => lapId !== null),
    ),
  ];
  if (lapIds.length > 0) {
    const lapRows = await tx
      .select({ id: laps.id, sessionId: laps.sessionId })
      .from(laps)
      .where(inArray(laps.id, lapIds))
      .all();
    if (lapRows.length !== lapIds.length) {
      throw new Error("Session run references a lap that does not exist");
    }
    const lapSessionById = new Map(
      lapRows.map((row) => [row.id, row.sessionId] as const),
    );
    for (const run of artifacts.runs) {
      for (const lapId of [run.startLapId, run.endLapId]) {
        if (lapId && lapSessionById.get(lapId) !== run.sessionId) {
          throw new Error("Session run lap belongs to another session");
        }
      }
    }
    for (const membership of artifacts.memberships) {
      const run = runById.get(membership.runId)!;
      if (
        membership.lapId != null &&
        lapSessionById.get(membership.lapId) !== run.sessionId
      ) {
        throw new Error("Session run membership lap belongs to another session");
      }
    }
  }
}

export async function appendSessionRunArtifactsInTransaction(
  tx: DbTransaction,
  input: SessionRunArtifacts,
): Promise<SessionRun[]> {
  const artifacts: SessionRunArtifacts = {
    runs: input.runs.map((run) => SessionRunSchema.parse(run)),
    memberships: input.memberships.map((membership) =>
      SessionRunLapMembershipSchema.parse(membership),
    ),
    evidence: input.evidence.map((item) => SessionRunEvidenceSchema.parse(item)),
  };
  const uniqueRuns = new Map<SessionRunId, SessionRun>();
  for (const run of artifacts.runs) {
    const duplicate = uniqueRuns.get(run.runId);
    if (duplicate && duplicate.contentHash !== run.contentHash) {
      throw new SessionRunConflictError(run.runId);
    }
    uniqueRuns.set(run.runId, run);
  }
  await assertArtifactOwnership(tx, artifacts);

  const runIds = [...uniqueRuns.keys()];
  const existingRows =
    runIds.length === 0
      ? []
      : await tx
          .select()
          .from(sessionRuns)
          .where(inArray(sessionRuns.runId, runIds))
          .all();
  const existingById = new Map(
    existingRows.map((row) => {
      const run = parseSessionRunRow(row);
      return [run.runId, run] as const;
    }),
  );
  const inserted: SessionRun[] = [];
  for (const run of uniqueRuns.values()) {
    const existing = existingById.get(run.runId);
    if (!existing) inserted.push(run);
    else if (existing.contentHash !== run.contentHash) {
      throw new SessionRunConflictError(run.runId);
    }
  }
  if (inserted.length > 0) {
    await tx.insert(sessionRuns).values(inserted.map(runInsert)).run();
  }

  for (const membership of artifacts.memberships) {
    await tx
      .insert(sessionRunLaps)
      .values(membership)
      .onConflictDoUpdate({
        target: [sessionRunLaps.runId, sessionRunLaps.lapEventId],
        set: { lapId: membership.lapId },
      })
      .run();
  }
  if (artifacts.evidence.length > 0) {
    await tx
      .insert(sessionRunEvidence)
      .values([...artifacts.evidence])
      .onConflictDoNothing()
      .run();
  }
  return inserted;
}

export function appendSessionRunArtifacts(
  input: SessionRunArtifacts,
  transaction?: DbTransaction,
): Promise<SessionRun[]> {
  if (transaction) return appendSessionRunArtifactsInTransaction(transaction, input);
  return db.transaction((tx) => appendSessionRunArtifactsInTransaction(tx, input));
}

async function rebuildPersistedSessionRunsInTransaction(
  tx: DbTransaction,
  sessionId: number,
): Promise<SessionRun[]> {
  const session = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session) throw new SessionRunNotFoundError();

  const eventRows = await tx
    .select()
    .from(raceEvents)
    .where(eq(raceEvents.sessionId, sessionId))
    .orderBy(
      asc(raceEvents.timelineEpoch),
      asc(raceEvents.sequence),
      asc(raceEvents.eventOrder),
      asc(raceEvents.eventId),
    )
    .all();
  const events = eventRows.map((row) => RaceEventSchema.parse(row));
  const completedByLapNumber = new Map<number, RaceEvent[]>();
  for (const event of events) {
    if (event.eventType !== "lap_completed") continue;
    const values =
      completedByLapNumber.get(event.payload.lapNumber) ?? [];
    values.push(event);
    completedByLapNumber.set(event.payload.lapNumber, values);
  }
  const lapRows = await tx
    .select()
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .orderBy(asc(laps.lapNumber), asc(laps.id))
    .all();
  const lapsByCompletionEventId = new Map<
    RaceEventId,
    CompletedSessionRunLap
  >();
  for (const lap of lapRows) {
    const candidates = completedByLapNumber.get(lap.lapNumber) ?? [];
    const event =
      candidates.find(
        (candidate) =>
          candidate.participantKind === "player" &&
          candidate.lapId === lap.id,
      ) ??
      candidates.find(
        (candidate) => candidate.participantKind === "player",
      );
    if (!event) continue;
    lapsByCompletionEventId.set(event.eventId, {
      lapEventId: event.eventId,
      lapId: lap.id,
      lapNumber: lap.lapNumber,
      lapTimeMs:
        Number.isFinite(lap.lapTime) && lap.lapTime > 0
          ? lap.lapTime * 1_000
          : null,
      isValid: lap.isValid,
      phase: lap.phase,
      conditions: lap.conditions,
      quality: lap.quality ?? null,
      eligibility: lap.eligibility ?? null,
      qualityGeneration: lap.qualityGeneration,
      qualityStale: lap.qualityGeneration === "legacy",
      qualitySchemaVersion: lap.qualitySchemaVersion,
      qualityPolicyVersion: lap.qualityPolicyVersion,
      qualityConfigVersion: lap.qualityConfigVersion,
    });
  }

  const builder = new SessionRunBuilder();
  const consumed = builder.consume({ events, lapsByCompletionEventId });
  consumed.commit();
  const finalized = builder.finalize({ sessionId });
  finalized.commit();
  const artifacts: SessionRunArtifacts = {
    runs: [...consumed.runs, ...finalized.runs],
    memberships: [...consumed.memberships, ...finalized.memberships],
    evidence: [...consumed.evidence, ...finalized.evidence],
  };
  await tx
    .delete(sessionRuns)
    .where(eq(sessionRuns.sessionId, sessionId))
    .run();
  await appendSessionRunArtifactsInTransaction(tx, artifacts);
  return [...artifacts.runs];
}

export function rebuildPersistedSessionRuns(
  sessionId: number,
  transaction?: DbTransaction,
): Promise<SessionRun[]> {
  if (transaction) {
    return rebuildPersistedSessionRunsInTransaction(transaction, sessionId);
  }
  return db.transaction((tx) =>
    rebuildPersistedSessionRunsInTransaction(tx, sessionId),
  );
}

export function appendRaceEventsWithSessionRunUpdate(
  events: readonly RaceEvent[],
  lapLinks: readonly RaceEventLapLink[],
  update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
): Promise<AppendedSessionRunArtifacts> {
  return db.transaction(async (tx) => {
    let appendedEvents = await appendRaceEvents(events, tx);
    for (const link of lapLinks) {
      const linked = await attachRaceEventsToLap(
        link.sessionId,
        link.lapNumber,
        link.lapId,
        tx,
      );
      const linkedById = new Map(linked.map((event) => [event.eventId, event]));
      appendedEvents = appendedEvents.map(
        (event) => linkedById.get(event.eventId) ?? event,
      );
    }
    const appendedRuns = await appendSessionRunArtifactsInTransaction(tx, update);
    return { events: appendedEvents, runs: appendedRuns };
  });
}

function cursorCondition(cursor: RunCursor): SQL {
  return or(
    gt(sessionRuns.timelineEpoch, cursor[0]),
    and(
      eq(sessionRuns.timelineEpoch, cursor[0]),
      gt(sessionRuns.openingSequence, cursor[1]),
    ),
    and(
      eq(sessionRuns.timelineEpoch, cursor[0]),
      eq(sessionRuns.openingSequence, cursor[1]),
      gt(sessionRuns.openingEventOrder, cursor[2]),
    ),
    and(
      eq(sessionRuns.timelineEpoch, cursor[0]),
      eq(sessionRuns.openingSequence, cursor[1]),
      eq(sessionRuns.openingEventOrder, cursor[2]),
      gt(sessionRuns.runId, cursor[3]),
    ),
  )!;
}

async function listConditions(
  sessionId: number | null,
  query: SessionRunListQuery,
): Promise<SQL[]> {
  const conditions: SQL[] = [];
  if (sessionId != null) conditions.push(eq(sessionRuns.sessionId, sessionId));
  if (query.runKind !== undefined) conditions.push(eq(sessionRuns.runKind, query.runKind));
  if (query.participantId !== undefined) conditions.push(eq(sessionRuns.participantId, query.participantId));
  if (query.driverId !== undefined) conditions.push(eq(sessionRuns.driverId, query.driverId));
  if (query.observedPhase !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(${sessionRuns.observedPhases}) WHERE value = ${query.observedPhase})`,
    );
  }
  if (query.timelineEpoch !== undefined) conditions.push(eq(sessionRuns.timelineEpoch, query.timelineEpoch));
  if (query.status !== undefined) conditions.push(eq(sessionRuns.status, query.status));
  if (query.minCompletedLaps !== undefined) {
    conditions.push(gte(sql<number>`json_extract(${sessionRuns.summary}, '$.completedLapCount')`, query.minCompletedLaps));
  }
  if (query.maxCompletedLaps !== undefined) {
    conditions.push(lte(sql<number>`json_extract(${sessionRuns.summary}, '$.completedLapCount')`, query.maxCompletedLaps));
  }
  if (query.qualityOnly) {
    conditions.push(sql`json_array_length(${sessionRuns.qualityFlags}) > 0`);
  }
  if (query.overlapsRunId !== undefined) {
    const relationRows = await db
      .select({ run: sessionRuns })
      .from(sessionRuns)
      .where(eq(sessionRuns.runId, query.overlapsRunId))
      .limit(1)
      .all();
    const relation = relationRows[0]?.run
      ? parseSessionRunRow(relationRows[0].run)
      : null;
    if (!relation || relation.runKind !== "tire" || (sessionId != null && relation.sessionId !== sessionId)) {
      throw new SessionRunNotFoundError();
    }
    conditions.push(
      eq(sessionRuns.sessionId, relation.sessionId),
      relation.participantId === null
        ? isNull(sessionRuns.participantId)
        : eq(sessionRuns.participantId, relation.participantId),
      eq(sessionRuns.timelineEpoch, relation.timelineEpoch),
      sql`(
        ${sessionRuns.closingEventId} IS NULL OR EXISTS (
          SELECT 1
          FROM race_events AS candidate_closing
          WHERE candidate_closing.event_id = ${sessionRuns.closingEventId}
            AND (
              candidate_closing.timeline_epoch > ${relation.timelineEpoch}
              OR (
                candidate_closing.timeline_epoch = ${relation.timelineEpoch}
                AND candidate_closing.sequence > ${relation.openingSequence}
              )
              OR (
                candidate_closing.timeline_epoch = ${relation.timelineEpoch}
                AND candidate_closing.sequence = ${relation.openingSequence}
                AND candidate_closing.event_order > ${relation.openingEventOrder}
              )
            )
        )
      )`,
    );
    if (relation.closingBoundary.eventId !== null) {
      const closing = await db
        .select({
          timelineEpoch: raceEvents.timelineEpoch,
          sequence: raceEvents.sequence,
          eventOrder: raceEvents.eventOrder,
        })
        .from(raceEvents)
        .where(eq(raceEvents.eventId, relation.closingBoundary.eventId))
        .get();
      if (!closing) throw new SessionRunNotFoundError();
      if (closing.timelineEpoch === relation.timelineEpoch) {
        conditions.push(
          or(
            lt(sessionRuns.openingSequence, closing.sequence),
            and(
              eq(sessionRuns.openingSequence, closing.sequence),
              lt(sessionRuns.openingEventOrder, closing.eventOrder),
            ),
          )!,
        );
      }
    }
  }
  if (query.cursor !== undefined) conditions.push(cursorCondition(decodeRunCursor(query.cursor)));
  return conditions;
}

async function listRuns(
  sessionId: number | null,
  query: SessionRunListQuery,
): Promise<SessionRunPage> {
  const limit = requestedLimit(query.limit);
  const conditions = await listConditions(sessionId, query);
  const rows = await db
    .select()
    .from(sessionRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      asc(sessionRuns.timelineEpoch),
      asc(sessionRuns.openingSequence),
      asc(sessionRuns.openingEventOrder),
      asc(sessionRuns.runId),
    )
    .limit(limit + 1)
    .all();
  const hasNextPage = rows.length > limit;
  const items = (hasNextPage ? rows.slice(0, limit) : rows).map(parseSessionRunRow);
  return SessionRunPageSchema.parse({
    items,
    nextCursor:
      hasNextPage && items.length > 0
        ? encodeCursor(runOrderTuple(items.at(-1)!))
        : null,
  });
}

export function listSessionRuns(
  sessionId: number,
  query: SessionRunListQuery = {},
): Promise<SessionRunPage> {
  return listRuns(sessionId, query);
}

export function listDriverStints(
  driverId: string,
  query: SessionRunListQuery = {},
): Promise<SessionRunPage> {
  return listRuns(null, { ...query, driverId, runKind: "driver" });
}

async function getRun(runId: SessionRunId): Promise<SessionRun> {
  const rows = await db
    .select()
    .from(sessionRuns)
    .where(eq(sessionRuns.runId, runId))
    .limit(1)
    .all();
  if (!rows[0]) throw new SessionRunNotFoundError();
  return parseSessionRunRow(rows[0]);
}

export async function listSessionRunLaps(
  runId: SessionRunId,
  query: SessionRunLapListQuery = {},
): Promise<SessionRunLapPage> {
  await getRun(runId);
  const limit = requestedLimit(query.limit);
  const conditions: SQL[] = [eq(sessionRunLaps.runId, runId)];
  if (query.cursor) {
    const cursor = decodePairCursor(query.cursor);
    conditions.push(
      or(
        gt(sessionRunLaps.ordinal, cursor[0]),
        and(
          eq(sessionRunLaps.ordinal, cursor[0]),
          gt(sessionRunLaps.lapEventId, cursor[1] as RaceEventId),
        ),
      )!,
    );
  }
  const rows = await db
    .select({ membership: sessionRunLaps, lap: laps })
    .from(sessionRunLaps)
    .leftJoin(laps, eq(sessionRunLaps.lapId, laps.id))
    .where(and(...conditions))
    .orderBy(asc(sessionRunLaps.ordinal), asc(sessionRunLaps.lapEventId))
    .limit(limit + 1)
    .all();
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const items = pageRows.map(({ membership, lap }) => {
    const parsedMembership = SessionRunLapMembershipSchema.parse(membership);
    const eligibility = lap
      ? resolveEligibilityDecision(lap, query.eligibilityPolicy ?? "normal-pace")
      : null;
    return {
      membership: parsedMembership,
      lap: lap
        ? {
            id: lap.id,
            sessionId: lap.sessionId,
            lapNumber: lap.lapNumber,
            lapTime: lap.lapTime,
            isValid: lap.isValid,
            phase: lap.phase,
            conditions: lap.conditions,
            quality: lap.quality ?? null,
          }
        : null,
      eligibility,
      exclusionReasons: eligibility?.reasons.map(({ code }) => code) ?? ["lap_metadata_unavailable"],
    };
  });
  return SessionRunLapPageSchema.parse({
    items,
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeCursor([
            pageRows.at(-1)!.membership.ordinal,
            pageRows.at(-1)!.membership.lapEventId,
          ])
        : null,
  });
}

export async function listSessionRunEvidence(
  runId: SessionRunId,
  query: { cursor?: string; limit?: number } = {},
): Promise<SessionRunEvidencePage> {
  await getRun(runId);
  const limit = requestedLimit(query.limit);
  const conditions: SQL[] = [eq(sessionRunEvidence.runId, runId)];
  if (query.cursor) {
    const cursor = decodeEvidenceCursor(query.cursor);
    conditions.push(
      or(
        gt(sessionRunEvidence.eventId, cursor[0]),
        and(
          eq(sessionRunEvidence.eventId, cursor[0]),
          gt(sessionRunEvidence.role, cursor[1]),
        ),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(sessionRunEvidence)
    .where(and(...conditions))
    .orderBy(asc(sessionRunEvidence.eventId), asc(sessionRunEvidence.role))
    .limit(limit + 1)
    .all();
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => SessionRunEvidenceSchema.parse(row));
  return SessionRunEvidencePageSchema.parse({
    items,
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeCursor([
            pageRows.at(-1)!.eventId,
            pageRows.at(-1)!.role,
          ])
        : null,
  });
}

export async function listComparableSessionRuns(
  runId: SessionRunId,
  query: ComparableSessionRunListQuery = {},
): Promise<ComparableSessionRunPage> {
  const reference = await getRun(runId);
  const referenceSession = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, reference.sessionId))
    .get();
  if (!referenceSession) throw new SessionRunNotFoundError();

  const limit = requestedLimit(query.limit);
  const conditions = await listConditions(null, {
    participantId: query.participantId,
    driverId: query.driverId,
    observedPhase: query.observedPhase,
    minCompletedLaps: query.minCompletedLaps,
    maxCompletedLaps: query.maxCompletedLaps,
    cursor: query.cursor,
    runKind: reference.runKind,
  });
  conditions.push(ne(sessionRuns.runId, reference.runId));
  if (query.gameId) conditions.push(eq(sessions.gameId, query.gameId));
  if (query.trackId) {
    conditions.push(
      sql`CAST(${sessions.trackOrdinal} AS TEXT) = ${query.trackId}`,
    );
  }
  if (query.classId) conditions.push(eq(sessionRuns.classId, query.classId));
  if (query.requireEnvironmentEvidence) conditions.push(sql`0 = 1`);

  const rows = await db
    .select({ run: sessionRuns, session: sessions })
    .from(sessionRuns)
    .innerJoin(sessions, eq(sessionRuns.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(
      asc(sessionRuns.timelineEpoch),
      asc(sessionRuns.openingSequence),
      asc(sessionRuns.openingEventOrder),
      asc(sessionRuns.runId),
    )
    .limit(limit + 1)
    .all();
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const parsedRows = pageRows.map(({ run, session }) => ({
    run: parseSessionRunRow(run),
    session,
  }));
  const pageRunIds = parsedRows.map(({ run }) => run.runId);
  const membershipRows =
    pageRunIds.length === 0
      ? []
      : await db
          .select({
            runId: sessionRunLaps.runId,
            lapId: sessionRunLaps.lapId,
            conditions: laps.conditions,
          })
          .from(sessionRunLaps)
          .leftJoin(laps, eq(sessionRunLaps.lapId, laps.id))
          .where(inArray(sessionRunLaps.runId, pageRunIds))
          .all();
  const membershipByRun = new Map<
    SessionRunId,
    Array<(typeof membershipRows)[number]>
  >();
  for (const membership of membershipRows) {
    const values = membershipByRun.get(membership.runId) ?? [];
    values.push(membership);
    membershipByRun.set(membership.runId, values);
  }

  const items = parsedRows.map(({ run, session }) => {
    const memberships = membershipByRun.get(run.runId) ?? [];
    const missingLapMetadata = memberships.some(
      ({ lapId, conditions: lapConditions }) =>
        lapId === null || lapConditions === null,
    );
    const memberConditions = missingLapMetadata
      ? null
      : [
          ...new Set(
            memberships.flatMap(({ conditions: lapConditions }) =>
              lapConditions ?? [],
            ),
          ),
        ].sort();
    const limitations = [
      ...(session.gameId === referenceSession.gameId
        ? []
        : ["game_mismatch"]),
      ...(session.trackOrdinal === referenceSession.trackOrdinal
        ? []
        : ["track_mismatch"]),
      ...(run.classId && reference.classId && run.classId !== reference.classId
        ? ["class_mismatch"]
        : []),
      ...(run.classId ? [] : ["class_evidence_unavailable"]),
      "environment_evidence_unavailable",
      ...(missingLapMetadata ? ["member_conditions_unavailable"] : []),
      ...(run.summary.cautionLapCount > 0
        ? ["contains_caution_laps"]
        : []),
      ...(run.summary.normalPaceLapCount < run.summary.completedLapCount
        ? ["contains_non_pace_laps"]
        : []),
    ];
    return {
      run,
      gameId: session.gameId,
      trackId: String(session.trackOrdinal),
      classEvidence: run.classId,
      environmentEvidence: null,
      memberConditions,
      compatibilityLimitations: limitations,
    };
  });
  return ComparableSessionRunPageSchema.parse({
    items,
    nextCursor:
      hasNextPage && parsedRows.length > 0
        ? encodeCursor(runOrderTuple(parsedRows.at(-1)!.run))
        : null,
  });
}
