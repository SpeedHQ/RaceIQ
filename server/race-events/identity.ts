import { createHash } from "node:crypto";

import { RACE_EVENT_SCHEMA_VERSION, type RaceEvent, type RaceEventDraft, type RaceEventId, type RaceEventType } from "../../shared/racing/events/contracts";
import type { RaceEventObservation } from "../games/types";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, canonicalize(input[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface RaceEventIdentityCoordinates {
  sessionId: number;
  participantId: string | null;
  timelineEpoch: number;
  eventType: RaceEventType;
  detectorId: string;
  boundaryKey: string;
  lifecycleId: string | null;
}

export interface RaceEventLifecycleIdentityCoordinates {
  sessionId: number;
  participantId: string | null;
  timelineEpoch: number;
  openingEventType: RaceEventType;
  detectorId: string;
  boundaryKey: string;
}

/**
 * Episode identity uses only opening-event semantic coordinates. Event IDs may
 * depend on this lifecycle ID, so event IDs must never feed this digest.
 */
export function raceEventLifecycleId(coordinates: RaceEventLifecycleIdentityCoordinates): string {
  return `race-lifecycle:sha256:${digest([
    RACE_EVENT_SCHEMA_VERSION,
    coordinates.sessionId,
    coordinates.participantId,
    coordinates.timelineEpoch,
    coordinates.openingEventType,
    coordinates.detectorId,
    coordinates.boundaryKey,
  ])}`;
}

/** Semantic identity deliberately excludes detector/algorithm version. */
export function raceEventId(coordinates: RaceEventIdentityCoordinates): RaceEventId {
  return `race-event:sha256:${digest([
    RACE_EVENT_SCHEMA_VERSION,
    coordinates.sessionId,
    coordinates.participantId,
    coordinates.timelineEpoch,
    coordinates.eventType,
    coordinates.detectorId,
    coordinates.boundaryKey,
    coordinates.lifecycleId,
  ])}` as RaceEventId;
}

/**
 * Semantic content omits persistence/provenance details that may be attached
 * after commit. Detector version is also omitted so an algorithm bump with no
 * factual change remains an exact semantic match.
 */
export function raceEventContentHash(event: Omit<RaceEvent, "eventId" | "contentHash" | "createdAt">): `sha256:${string}` {
  const {
    lapId: _lapId,
    receivedAtMs: _receivedAtMs,
    sourceGeneration: _sourceGeneration,
    analysisGenerationId: _analysisGenerationId,
    detectorVersion: _detectorVersion,
    eventOrder: _eventOrder,
    ...semantic
  } = event;
  return `sha256:${digest(semantic)}`;
}

export function observationContentHash(observation: RaceEventObservation): string {
  const { receivedAtMs: _receivedAtMs, sourceTimeMs, participants, sourceSequences, ...rest } = observation;
  return digest({
    ...rest,
    sourceTimeMs: sourceSequences.length === 0 ? sourceTimeMs : null,
    sourceSequences: [...sourceSequences].sort((left, right) => left.family.localeCompare(right.family) || left.sequence - right.sequence),
    participants: [...participants]
      .sort((left, right) => left.participantId.localeCompare(right.participantId))
      .map((participant) => ({
        ...participant,
        damage: participant.damage == null ? null : Object.fromEntries(Object.entries(participant.damage).sort(([left], [right]) => left.localeCompare(right))),
      })),
  });
}

export function observationBoundaryKey(observation: RaceEventObservation, fallbackOrdinal: number): string {
  if (observation.sourceSequences.length > 0) {
    const sourceKey = [...observation.sourceSequences]
      .sort((left, right) => left.family.localeCompare(right.family) || left.sequence - right.sequence)
      .map(({ family, sequence }) => `${family}:${sequence}`)
      .join("|");
    return observation.gameId === "iracing" && observation.lapNumber != null ? `${sourceKey}|physical-lap:${observation.lapNumber}` : sourceKey;
  }
  return `observation:${fallbackOrdinal}`;
}

export function nativeCoordinateKey(observation: RaceEventObservation): string | null {
  if (observation.sourceSequences.length === 0) {
    if (!Number.isFinite(observation.sourceTimeMs)) return null;
    return `source-time:${observation.sourceTimeMs}|physical-lap:${observation.lapNumber ?? "unknown"}`;
  }
  return observationBoundaryKey(observation, 0);
}

export function materializeRaceEvent(draft: RaceEventDraft, boundaryKey: string, createdAt: string): RaceEvent {
  const eventId = raceEventId({
    sessionId: draft.sessionId,
    participantId: draft.participantId,
    timelineEpoch: draft.timelineEpoch,
    eventType: draft.eventType,
    detectorId: draft.detectorId,
    boundaryKey,
    lifecycleId: draft.lifecycleId,
  });
  return {
    ...draft,
    eventId,
    contentHash: raceEventContentHash(draft),
    createdAt,
  } as RaceEvent;
}
