import { createHash } from "crypto";
import type { GameId, TelemetryPacket } from "../../shared/types";
import {
  getLapsByIds,
  getLapsForSession,
  getSessions,
  getSessionResult,
  getSessionRawFile,
  getSessionTelemetry,
  upsertSessionResult,
} from "../db/queries";
import { deriveRaceResult, normalizeSessionType } from "./derive";
import { extractRaceSource } from "./source";
import type { PitEvent } from "./types";
import type { RaceResultCanonicalInputIdentity, RaceResultRawInputIdentity } from "../../shared/race-results";
import { loadRawCaptureIdentity, rawCaptureObjectId } from "../raw-capture-identity";


function canonicalInputIdentity(sessionId: number, packets: readonly TelemetryPacket[]): RaceResultCanonicalInputIdentity | null {
  if (packets.length === 0) return null;
  const hash = createHash("sha256");
  for (const packet of packets) {
    hash.update(JSON.stringify(packet));
    hash.update("\n");
  }
  return {
    sessionId: String(sessionId),
    firstSequence: 0,
    lastSequence: packets.length - 1,
    contentHash: `sha256:${hash.digest("hex")}`,
  };
}

async function rawInputIdentity(
  sessionId: number,
  rawFile: string | null | undefined,
): Promise<RaceResultRawInputIdentity | null> {
  if (!rawFile) return null;
  try {
    const capture = await loadRawCaptureIdentity(rawFile);
    return capture
      ? { objectId: rawCaptureObjectId(sessionId), contentHash: capture.contentHash }
      : null;
  } catch {
    return null;
  }
}

export interface ReconcileSessionReport {
  sessionId: number;
  status: "enriched" | "unchanged" | "skipped" | "ambiguous" | "error";
  eventCount: number;
  reasons: string[];
}

export interface BackfillReport {
  processed: number;
  enriched: number;
  unchanged: number;
  skipped: number;
  ambiguous: number;
  errors: number;
  results: ReconcileSessionReport[];
}

function toStoredPitEvent(event: PitEvent) {
  return {
    sequence: event.sequence,
    lapNumber: event.lapNumber,
    elapsedSeconds: event.elapsedSeconds,
    durationSeconds: event.durationSeconds,
    service: event.service,
    tyreChange: event.tyreChange,
    fuelAdded: event.fuelAdded,
    fuelBefore: event.fuelBefore,
    fuelAfter: event.fuelAfter,
    linkage: event.linkage,
    source: event.source,
  };
}


export async function reconcileSessionResult(sessionId: number, gameId: GameId): Promise<ReconcileSessionReport> {
  const sessions = await getSessions(gameId);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return { sessionId, status: "skipped", eventCount: 0, reasons: ["session-not-found"] };

  const readReasons: string[] = [];
  let packets: TelemetryPacket[] = [];
  try {
    packets = await getSessionTelemetry(sessionId, gameId);
  } catch {
    readReasons.push("session-raw-parse-error");
  }

  // Legacy/imported sessions may not have a complete raw capture. Their
  // persisted lap ranges remain a deterministic, explicitly limited fallback.
  if (packets.length === 0) {
    const lapRefs = await getLapsForSession(sessionId);
    const laps = await getLapsByIds(lapRefs.map((lap) => lap.id));
    for (const lap of laps) {
      if (lap.parseError) readReasons.push(`lap-${lap.id}-parse-error`);
      packets.push(...lap.telemetry);
    }
    if (laps.length !== lapRefs.length) {
      const loadedIds = new Set(laps.map((lap) => lap.id));
      for (const lap of lapRefs) {
        if (!loadedIds.has(lap.id)) readReasons.push(`lap-${lap.id}-missing`);
      }
    }
  }

  const source = extractRaceSource(gameId, packets);
  if (session.sessionType) {
    if (!source.sessionType) {
      source.sessionType = session.sessionType;
      source.evidence.fieldStatus.sessionType = "direct";
      const fields = source.provenance.fields as Record<string, unknown> | undefined;
      if (fields) fields.sessionType = "sessions.session_type";
    } else if (normalizeSessionType(session.sessionType) !== normalizeSessionType(source.sessionType)) {
      source.evidence.conflicts.push(`session-type:session-row=${session.sessionType}|telemetry=${source.sessionType}`);
    }
  }
  const derived = deriveRaceResult({
    ...source,
    reasons: [...source.reasons, ...readReasons],
  });
  derived.provenance = {
    ...derived.provenance,
    rawInput: await rawInputIdentity(sessionId, await getSessionRawFile(sessionId, gameId)),
    canonicalInput: canonicalInputIdentity(sessionId, packets),
  };
  const storedEvents = derived.events.map(toStoredPitEvent);
  const existing = await getSessionResult(sessionId, gameId);
  const unchanged = existing != null &&
    existing.sessionType === derived.sessionType &&
    existing.classification === derived.classification &&
    existing.outcomeStatus === derived.outcomeStatus &&
    existing.finishingPosition === derived.finishingPosition &&
    existing.qualifyingPosition === derived.qualifyingPosition &&
    existing.isPodium === derived.isPodium &&
    existing.isFastestLap === derived.isFastestLap &&
    existing.pitCount === derived.pitCount &&
    JSON.stringify(existing.tyreStrategy) === JSON.stringify(derived.tyreStrategy) &&
    JSON.stringify(existing.fuelStrategy) === JSON.stringify(derived.fuelStrategy) &&
    JSON.stringify(existing.provenance) === JSON.stringify(derived.provenance) &&
    JSON.stringify(existing.evidence) === JSON.stringify(derived.evidence) &&
    JSON.stringify(existing.reasons) === JSON.stringify(derived.reasons) &&
    existing.events.length === derived.events.length &&
    existing.events.every((event, index) => {
      const expected = derived.events[index];
      return expected != null &&
        event.sequence === expected.sequence &&
        event.lapNumber === expected.lapNumber &&
        event.elapsedSeconds === expected.elapsedSeconds &&
        event.durationSeconds === expected.durationSeconds &&
        event.service === expected.service &&
        event.fuelAdded === expected.fuelAdded &&
        event.fuelBefore === expected.fuelBefore &&
        event.fuelAfter === expected.fuelAfter &&
        event.linkage === expected.linkage &&
        JSON.stringify(event.tyreChange) === JSON.stringify(expected.tyreChange) &&
        JSON.stringify(event.source) === JSON.stringify(expected.source);
    });
  await upsertSessionResult({
    sessionId,
    sessionType: derived.sessionType,
    classification: derived.classification,
    outcomeStatus: derived.outcomeStatus,
    finishingPosition: derived.finishingPosition,
    qualifyingPosition: derived.qualifyingPosition,
    isPodium: derived.isPodium,
    isFastestLap: derived.isFastestLap,
    pitCount: derived.pitCount,
    tyreStrategy: derived.tyreStrategy,
    fuelStrategy: derived.fuelStrategy,
    provenance: derived.provenance,
    evidence: derived.evidence,
    reasons: derived.reasons,
  }, storedEvents);

  const status = unchanged
    ? "unchanged"
    : derived.outcomeStatus === "confirmed"
      ? "enriched"
      : "ambiguous";
  return { sessionId, status, eventCount: derived.events.length, reasons: derived.reasons };
}

export async function backfillRaceResults(options: { gameId: GameId; limit: number; afterSessionId?: number }): Promise<BackfillReport> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const sessions = (await getSessions(options.gameId))
    .filter((session) => options.afterSessionId == null || session.id > options.afterSessionId)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);
  const results: ReconcileSessionReport[] = [];
  for (const session of sessions) {
    try {
      results.push(await reconcileSessionResult(session.id, options.gameId));
    } catch (error) {
      results.push({ sessionId: session.id, status: "error", eventCount: 0, reasons: [error instanceof Error ? error.message : "unknown-error"] });
    }
  }
  return {
    processed: results.length,
    enriched: results.filter((result) => result.status === "enriched").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    ambiguous: results.filter((result) => result.status === "ambiguous").length,
    errors: results.filter((result) => result.status === "error").length,
    results,
  };
}
