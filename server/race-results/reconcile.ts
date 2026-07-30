import type { GameId, TelemetryPacket } from "../../shared/types";
import {
  getLapById,
  getLapsForSession,
  getSessions,
  getSessionResult,
  replacePitEvents,
  upsertSessionResult,
} from "../db/queries";
import { deriveRaceResult } from "./derive";
import { extractRaceSource } from "./source";
import type { PitEvent } from "./types";

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

  const packets: TelemetryPacket[] = [];
  const reasons: string[] = [];
  for (const lapId of await getLapsForSession(sessionId)) {
    const lap = await getLapById(lapId.id);
    if (!lap) {
      reasons.push(`lap-${lapId.id}-missing`);
      continue;
    }
    if (lap.parseError) reasons.push(`lap-${lapId.id}-parse-error`);
    packets.push(...lap.telemetry);
  }

  const source = extractRaceSource(gameId, packets);
  const derived = deriveRaceResult({ ...source, sessionType: session.sessionType ?? source.sessionType, reasons });
  const existing = await getSessionResult(sessionId, gameId);
  const unchanged = existing != null &&
    existing.sessionType === derived.sessionType &&
    existing.classification === derived.classification &&
    existing.finishingPosition === derived.finishingPosition &&
    existing.qualifyingPosition === derived.qualifyingPosition &&
    existing.isPodium === derived.isPodium &&
    existing.isFastestLap === derived.isFastestLap &&
    existing.pitCount === derived.pitCount &&
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
        JSON.stringify(event.tyreChange) === JSON.stringify(expected.tyreChange);
    });
  const result = await upsertSessionResult({
    sessionId,
    sessionType: derived.sessionType,
    classification: derived.classification,
    finishingPosition: derived.finishingPosition,
    qualifyingPosition: derived.qualifyingPosition,
    isPodium: derived.isPodium,
    isFastestLap: derived.isFastestLap,
    pitCount: derived.pitCount,
    tyreStrategy: derived.tyreStrategy,
    fuelStrategy: derived.fuelStrategy,
    provenance: derived.provenance,
    reasons: derived.reasons,
  });
  await replacePitEvents(result.id, derived.events.map(toStoredPitEvent));

  const status = unchanged
    ? "unchanged"
    : derived.reasons.some((reason) => reason.includes("unknown") || reason.includes("unsupported"))
      ? "ambiguous"
      : "enriched";
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
