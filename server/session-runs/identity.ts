import { createHash } from "node:crypto";

import {
  SESSION_RUN_SCHEMA_VERSION,
  type SessionRun,
  type SessionRunEvidence,
  type SessionRunId,
  type SessionRunKind,
  type SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import { canonicalJson } from "../race-events/identity";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface SessionRunIdentityCoordinates {
  sessionId: number;
  participantId: string | null;
  runKind: SessionRunKind;
  timelineEpoch: number;
  openingEventId: RaceEventId;
}

/** Semantic identity remains stable across algorithm and persistence revisions. */
export function sessionRunId(
  coordinates: SessionRunIdentityCoordinates,
): SessionRunId {
  return `session-run:sha256:${digest([
    SESSION_RUN_SCHEMA_VERSION,
    coordinates.sessionId,
    coordinates.participantId,
    coordinates.runKind,
    coordinates.timelineEpoch,
    coordinates.openingEventId,
  ])}` as SessionRunId;
}

export interface SessionRunContentInput {
  run: Omit<SessionRun, "contentHash" | "createdAt"> &
    Partial<Pick<SessionRun, "contentHash" | "createdAt">>;
  memberships: readonly SessionRunLapMembership[];
  evidence: readonly SessionRunEvidence[];
}

/**
 * Hashes factual run output only. Database links, generations, algorithm
 * versions, timestamps, and persistence ordering cannot change semantic hash.
 */
export function sessionRunContentHash({
  run,
  memberships,
  evidence,
}: SessionRunContentInput): `sha256:${string}` {
  const {
    runId: _runId,
    algorithmVersion: _algorithmVersion,
    openingEventOrder: _openingEventOrder,
    startLapId: _startLapId,
    endLapId: _endLapId,
    sourceGeneration: _sourceGeneration,
    analysisGenerationId: _analysisGenerationId,
    contentHash: _contentHash,
    createdAt: _createdAt,
    openingBoundary,
    closingBoundary,
    ...semanticRun
  } = run;
  const semanticMemberships = [...memberships]
    .sort((left, right) =>
      left.ordinal === right.ordinal
        ? left.lapEventId.localeCompare(right.lapEventId)
        : left.ordinal - right.ordinal,
    )
    .map(({ lapId: _lapId, runId: _membershipRunId, ...membership }) =>
      membership,
    );
  const semanticEvidence = [...evidence]
    .map(({ runId: _evidenceRunId, ...item }) => item)
    .sort((left, right) => {
      const eventOrder = left.eventId.localeCompare(right.eventId);
      return eventOrder === 0 ? left.role.localeCompare(right.role) : eventOrder;
    });

  return `sha256:${digest({
    ...semanticRun,
    openingBoundary: {
      reason: openingBoundary.reason,
      eventId: openingBoundary.eventId,
      confidence: openingBoundary.confidence,
      evidenceKind: openingBoundary.evidenceKind,
    },
    closingBoundary: {
      reason: closingBoundary.reason,
      eventId: closingBoundary.eventId,
      confidence: closingBoundary.confidence,
      evidenceKind: closingBoundary.evidenceKind,
    },
    memberships: semanticMemberships,
    evidence: semanticEvidence,
  })}`;
}
