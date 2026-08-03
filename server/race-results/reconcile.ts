import { createHash } from "crypto";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getLapsByIds } from "../db/lap-read-queries";
import { getLapsForSession } from "../db/lap-reprocessing-queries";
import { getSessions } from "../db/session-queries";
import { getSessionResult, upsertSessionResult } from "../db/session-result-queries";
import { getSessionRawFile, getSessionTelemetry } from "../db/telemetry-replay-storage";
import { deriveRaceResult, normalizeSessionType } from "./derive";
import { extractRaceSource } from "./source";
import type { RaceResultCanonicalInputIdentity, RaceResultRawInputIdentity } from "../../shared/race-results/types";
import { loadRawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";

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
  }, derived.events);

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
  const counts: Record<ReconcileSessionReport["status"], number> = {
    enriched: 0,
    unchanged: 0,
    skipped: 0,
    ambiguous: 0,
    error: 0,
  };
  for (const result of results) counts[result.status]++;
  return {
    processed: results.length,
    enriched: counts.enriched,
    unchanged: counts.unchanged,
    skipped: counts.skipped,
    ambiguous: counts.ambiguous,
    errors: counts.error,
    results,
  };
}
