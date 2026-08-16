import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getLapsByIds } from "../db/lap-read-queries";
import { getLapsForSession } from "../db/lap-reprocessing-queries";
import { getSessions } from "../db/session-queries";
import { getSessionResult, getStaleRaceResultSessionIds, upsertSessionResult } from "../db/session-result-queries";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { getSessionRawFile, getSessionTelemetry } from "../db/telemetry-replay-storage";
import { deriveRaceResult, normalizeSessionType } from "./derive";
import { extractRaceSource } from "./source";
import type { PitEvent } from "./types";
import type { RaceResultCanonicalInputIdentity, RaceResultRawInputIdentity } from "../../shared/racing/results/types";
import { loadRawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";
import { getAllServerGames } from "../games/registry";

export const RACE_RESULT_PROCESSOR_ID = "race-result-v3";

function canonicalInputIdentity(sessionId: number, packets: readonly TelemetryPacket[]): RaceResultCanonicalInputIdentity | null {
  if (packets.length === 0) return null;
  const hash = createHash("sha256");
  for (const packet of packets) {
    hash.update(JSON.stringify(packet));
    hash.update("\n");
  }
  return { sessionId: String(sessionId), firstSequence: 0, lastSequence: packets.length - 1, contentHash: `sha256:${hash.digest("hex")}` };
}

async function rawInputIdentity(sessionId: number, rawFile: string | null | undefined): Promise<RaceResultRawInputIdentity | null> {
  if (!rawFile) return null;
  try {
    const capture = await loadRawCaptureIdentity(rawFile);
    return capture ? { objectId: rawCaptureObjectId(sessionId), contentHash: capture.contentHash } : null;
  } catch {
    return null;
  }
}

function toStoredPitEvent(event: PitEvent) {
  return {
    sequence: event.sequence,
    eventType: event.eventType ?? "pit",
    lapNumber: event.lapNumber,
    elapsedSeconds: event.elapsedSeconds,
    durationSeconds: event.durationSeconds,
    service: event.service,
    tyreChange: event.tyreChange,
    fuelAdded: event.fuelAdded,
    fuelBefore: event.fuelBefore,
    fuelAfter: event.fuelAfter,
    positionBefore: event.positionBefore ?? null,
    positionAfter: event.positionAfter ?? null,
    linkage: event.linkage,
    source: event.source,
  };
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
  if (packets.length === 0) {
    const lapRefs = await getLapsForSession(sessionId);
    const laps = await getLapsByIds(lapRefs.map((lap) => lap.id));
    for (const lap of laps) {
      if (lap.parseError) readReasons.push(`lap-${lap.id}-parse-error`);
      packets.push(...lap.telemetry);
    }
    if (laps.length !== lapRefs.length) {
      const loadedIds = new Set(laps.map((lap) => lap.id));
      for (const lap of lapRefs) if (!loadedIds.has(lap.id)) readReasons.push(`lap-${lap.id}-missing`);
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
  const derived = deriveRaceResult({ ...source, reasons: [...source.reasons, ...readReasons] });
  derived.provenance = {
    ...derived.provenance,
    rawInput: await rawInputIdentity(sessionId, await getSessionRawFile(sessionId, gameId)),
    canonicalInput: canonicalInputIdentity(sessionId, packets),
  };
  const existing = await getSessionResult(sessionId, gameId);
  const unchanged =
    existing != null &&
    existing.processorVersion === RACE_RESULT_PROCESSOR_ID &&
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
      return (
        expected != null &&
        event.sequence === expected.sequence &&
        event.eventType === (expected.eventType ?? "pit") &&
        event.positionBefore === (expected.positionBefore ?? null) &&
        event.positionAfter === (expected.positionAfter ?? null) &&
        event.lapNumber === expected.lapNumber &&
        event.elapsedSeconds === expected.elapsedSeconds &&
        event.durationSeconds === expected.durationSeconds &&
        event.service === expected.service &&
        event.fuelAdded === expected.fuelAdded &&
        event.fuelBefore === expected.fuelBefore &&
        event.fuelAfter === expected.fuelAfter &&
        event.linkage === expected.linkage &&
        JSON.stringify(event.tyreChange) === JSON.stringify(expected.tyreChange) &&
        JSON.stringify(event.source) === JSON.stringify(expected.source)
      );
    });
  if (!unchanged) {
    await upsertSessionResult(
      {
        sessionId,
        processorVersion: RACE_RESULT_PROCESSOR_ID,
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
      },
      derived.events.map(toStoredPitEvent),
    );
  }
  await linkSessionQualityEvents(sessionId);

  const status = unchanged ? "unchanged" : derived.outcomeStatus === "confirmed" ? "enriched" : "ambiguous";
  return { sessionId, status, eventCount: derived.events.length, reasons: derived.reasons };
}

const reconciliationInFlight = new Map<number, Promise<ReconcileSessionReport>>();

export function reconcileSessionResultAfterLap(sessionId: number, gameId: GameId): Promise<ReconcileSessionReport> {
  const existing = reconciliationInFlight.get(sessionId);
  if (existing) return existing;
  const pending = reconcileSessionResult(sessionId, gameId).finally(() => reconciliationInFlight.delete(sessionId));
  reconciliationInFlight.set(sessionId, pending);
  return pending;
}

export async function backfillRaceResults(options: { gameId: GameId; limit: number; afterSessionId?: number; eligibleSessionIds?: ReadonlySet<number> }): Promise<BackfillReport> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const sessions = (await getSessions(options.gameId))
    .filter((session) => options.eligibleSessionIds?.has(session.id) ?? true)
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
  const counts: Record<ReconcileSessionReport["status"], number> = { enriched: 0, unchanged: 0, skipped: 0, ambiguous: 0, error: 0 };
  for (const result of results) counts[result.status]++;
  return { processed: results.length, enriched: counts.enriched, unchanged: counts.unchanged, skipped: counts.skipped, ambiguous: counts.ambiguous, errors: counts.error, results };
}

/** Reconcile only missing results or rows written by an older processor. */
export async function backfillStaleRaceResults(options: { gameId: GameId; limit: number; afterSessionId?: number }): Promise<BackfillReport> {
  const eligibleSessionIds = new Set(await getStaleRaceResultSessionIds(RACE_RESULT_PROCESSOR_ID));
  return backfillRaceResults({ ...options, eligibleSessionIds });
}
export async function backfillAllRaceResults(): Promise<void> {
  for (const game of getAllServerGames()) {
    let afterSessionId: number | undefined;
    let totals = { processed: 0, enriched: 0, unchanged: 0, ambiguous: 0, errors: 0 };
    try {
      while (true) {
        const report = await backfillStaleRaceResults({ gameId: game.id, limit: 100, afterSessionId });
        totals = {
          processed: totals.processed + report.processed,
          enriched: totals.enriched + report.enriched,
          unchanged: totals.unchanged + report.unchanged,
          ambiguous: totals.ambiguous + report.ambiguous,
          errors: totals.errors + report.errors,
        };
        const lastSessionId = report.results.at(-1)?.sessionId;
        if (lastSessionId != null) afterSessionId = lastSessionId;
        if (report.processed < 100 || lastSessionId == null) break;
        await Bun.sleep(0);
      }
      console.log(`[RaceResults] Backfill ${game.id}: ${JSON.stringify(totals)}`);
    } catch (error) {
      console.error(`[RaceResults] Backfill failed for ${game.id}:`, error);
    }
  }
}
