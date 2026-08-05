import type { RaceResultClaimEvidence, RaceResultEvidence, RaceResultSourceStatus } from "../../shared/racing/results/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { derivePitLedger, type PitServiceSignals } from "./pit-ledger";
import type { RaceSourceObservation, ResultClassification } from "./types";
import { createRaceResultProvenance } from "./provenance";
import { resolveRaceResultAuthorityFromSourceStatus } from "./authority";

const SOURCE_EXTRACTOR = { id: "race-result-source", version: "3" } as const;

function classifyF1Result(status: number | undefined): ResultClassification | null {
  switch (status) {
    case 3: return "finished";
    case 4: return "dnf";
    case 5: return "disqualified";
    case 6: return "not-classified";
    case 7: return "retired";
    default: return null;
  }
}

function positive(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function extractPitSignals(gameId: GameId, packets: TelemetryPacket[]): PitServiceSignals[] | undefined {
  if (packets.length === 0) return undefined;
  if (gameId === "acc" || gameId === "ac-evo") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const status = packet.acc?.pitStatus ?? "out";
      const nextInPit = status !== "out";
      if (nextInPit && !inPit) signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { channel: "acc.pitStatus", value: status } });
      inPit = nextInPit;
    }
    return signals;
  }
  if (gameId === "f1-2025") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const nextInPit = packet.f1?.pitLaneTimerActive === 1;
      if (nextInPit && !inPit) signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { channel: "f1.pitLaneTimerActive", value: 1 } });
      inPit = nextInPit;
    }
    return signals;
  }
  if (gameId === "iracing") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const nextInPit = packet.iracing?.onPitRoad === true;
      if (nextInPit && !inPit) signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { channel: "iracing.onPitRoad", value: true } });
      inPit = nextInPit;
    }
    return signals;
  }
  return undefined;
}

function extractF1Result(packets: TelemetryPacket[]) {
  let sessionType: string | null = null;
  let finalClassification: ResultClassification | null = null;
  let liveClassification: ResultClassification | null = null;
  let finalPosition: number | null = null;
  let livePosition: number | null = null;
  let finalGridPosition: number | null = null;
  let liveGridPosition: number | null = null;
  let resultReason: number | null = null;
  let isFastestLap: boolean | null = null;
  const finalClassifications = new Set<ResultClassification>();
  const liveClassifications = new Set<ResultClassification>();
  const sessionTypes = new Map<string, string>();
  const classificationClaims: Array<{ classification: ResultClassification; source: "final-classification" | "lap-data"; observedAt: number; sequence: number }> = [];

  for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
    const packet = packets[packetIndex]!;
    const f1 = packet.f1;
    if (f1?.sessionType && f1.sessionType !== "unknown") {
      sessionType = f1.sessionType;
      sessionTypes.set(f1.sessionType.trim().toLowerCase(), f1.sessionType);
    }
    const observedClassification = classifyF1Result(f1?.resultStatus);
    if (observedClassification) {
      const observedAt = packet.TimestampMS ?? packet.CurrentRaceTime * 1000;
      const claimSource = f1?.resultSource === "final-classification" ? "final-classification" : "lap-data";
      classificationClaims.push({ classification: observedClassification, source: claimSource, observedAt: Number.isFinite(observedAt) ? observedAt : packetIndex, sequence: packetIndex });
      if (f1?.resultSource === "final-classification") {
        finalClassifications.add(observedClassification);
        finalClassification = observedClassification;
        finalPosition = positive(packet.RacePosition);
        finalGridPosition = positive(f1.gridPosition);
        resultReason = f1.resultReason ?? null;
      } else {
        liveClassifications.add(observedClassification);
        liveClassification = observedClassification;
      }
    }
    livePosition = positive(packet.RacePosition) ?? livePosition;
    liveGridPosition = positive(f1?.gridPosition) ?? liveGridPosition;
    const bestLap = positive(packet.BestLap);
    if (bestLap != null && f1?.grid) {
      let gridBest: number | null = null;
      for (const entry of f1.grid) {
        const candidate = positive(entry.bestLapTime);
        if (candidate != null && (gridBest == null || candidate < gridBest)) gridBest = candidate;
      }
      if (gridBest != null) isFastestLap = bestLap <= gridBest;
    }
  }
  const conflicts: string[] = [];
  const selectedClassifications = finalClassifications.size > 0 ? finalClassifications : liveClassifications;
  if (selectedClassifications.size > 1) conflicts.push(`classification:${[...selectedClassifications].join("|")}`);
  if (sessionTypes.size > 1) conflicts.push(`session-type:${[...sessionTypes.values()].join("|")}`);
  return {
    sessionType,
    classification: finalClassification ?? liveClassification,
    classificationSource: finalClassification ? "final-classification" as const : liveClassification ? "lap-data" as const : null,
    finishingPosition: finalPosition ?? livePosition,
    finishingPositionSource: finalPosition != null ? "final-classification" as const : livePosition != null ? "lap-data" as const : null,
    qualifyingPosition: finalGridPosition ?? liveGridPosition,
    qualifyingPositionSource: finalGridPosition != null ? "final-classification" as const : liveGridPosition != null ? "lap-data" as const : null,
    resultReason,
    isFastestLap,
    classificationClaims,
    conflicts,
  };
}

function latestSessionType(gameId: GameId, packets: TelemetryPacket[]): string | null {
  for (let index = packets.length - 1; index >= 0; index--) {
    const packet = packets[index];
    const value = gameId === "f1-2025" ? packet?.f1?.sessionType : packet?.acc?.acEvo?.sessionType;
    if (value && value !== "unknown") return value;
  }
  return null;
}

function latestPosition(packets: TelemetryPacket[]): number | null {
  for (let index = packets.length - 1; index >= 0; index--) {
    const value = positive(packets[index]?.RacePosition);
    if (value != null) return value;
  }
  return null;
}

function initialTyreCompound(packets: TelemetryPacket[]): unknown {
  for (const packet of packets) {
    const value = packet.f1?.tyreCompound ?? packet.acc?.tireCompound;
    if (value != null && value !== "") return value;
  }
  return null;
}

function initialFuelPerLap(packets: TelemetryPacket[]): number | null {
  for (const packet of packets) {
    const value = packet.acc?.fuelPerLap;
    if (value != null && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function extractPositionChanges(packets: TelemetryPacket[]) {
  const lapPositions = new Map<number, number>();
  for (const packet of packets) {
    if (packet.LapNumber == null || packet.LapNumber <= 0 || packet.RacePosition == null || packet.RacePosition <= 0) continue;
    lapPositions.set(packet.LapNumber, packet.RacePosition);
  }
  const changes = [];
  let previousPosition: number | null = null;
  for (const [lapNumber, position] of [...lapPositions.entries()].sort(([a], [b]) => a - b)) {
    if (previousPosition != null && position !== previousPosition) {
      changes.push({
        eventType: "position-change" as const,
        sequence: 100000 + lapNumber,
        lapNumber,
        elapsedSeconds: null,
        durationSeconds: null,
        service: "unknown" as const,
        tyreChange: null,
        fuelAdded: null,
        fuelBefore: null,
        fuelAfter: null,
        positionBefore: previousPosition,
        positionAfter: position,
        linkage: "linked" as const,
        source: { telemetry: "RacePosition", boundary: "lap-end" },
      });
    }
    previousPosition = position;
  }
  return changes.length > 0 ? changes : undefined;
}

function status(available: boolean, availableStatus: RaceResultSourceStatus): RaceResultSourceStatus {
  return available ? availableStatus : "unavailable";
}

export function extractRaceSource(gameId: GameId, packets: TelemetryPacket[]): RaceSourceObservation {
  const pitSignals = extractPitSignals(gameId, packets);
  const f1 = gameId === "f1-2025" ? extractF1Result(packets) : null;
  const sessionType = f1?.sessionType ?? latestSessionType(gameId, packets);
  const finishingPosition = f1?.finishingPosition ?? latestPosition(packets);
  const classification = f1?.classification ?? null;
  const qualifyingPosition = f1?.qualifyingPosition ?? null;
  const isFastestLap = f1?.isFastestLap ?? null;
  const tyreStrategy = initialTyreCompound(packets);
  const fuelPerLap = initialFuelPerLap(packets);
  const fuelStrategy = fuelPerLap == null ? null : { fuelPerLap };
  const fieldStatus: RaceResultEvidence["fieldStatus"] = {
    sessionType: status(sessionType != null, "direct"),
    classification: status(classification != null, f1?.classificationSource === "final-classification" ? "direct" : "simplified"),
    finishingPosition: status(finishingPosition != null, f1?.finishingPositionSource === "final-classification" ? "direct" : "simplified"),
    qualifyingPosition: status(qualifyingPosition != null, f1?.qualifyingPositionSource === "final-classification" ? "direct" : "simplified"),
    isPodium: "unavailable",
    isFastestLap: status(isFastestLap != null, "derived"),
    pitEvents: status(pitSignals != null, "derived"),
    tyreStrategy: status(tyreStrategy != null, "simplified"),
    fuelStrategy: status(fuelStrategy != null, "simplified"),
  };
  const positionChanges = extractPositionChanges(packets);
  const provenance = createRaceResultProvenance(gameId, {
    extractor: SOURCE_EXTRACTOR,
    fields: {
      sessionType: fieldStatus.sessionType === "direct" ? (gameId === "f1-2025" ? "f1.sessionType" : "acc.acEvo.sessionType") : null,
      classification: classification == null ? null : `f1.resultStatus:${f1?.classificationSource ?? "unknown"}`,
      finishingPosition: finishingPosition == null ? null : `TelemetryPacket.RacePosition:${f1?.finishingPositionSource ?? "continuous"}`,
      qualifyingPosition: qualifyingPosition == null ? null : `f1.gridPosition:${f1?.qualifyingPositionSource ?? "unknown"}`,
      isFastestLap: isFastestLap == null ? null : "player-vs-f1.grid.bestLapTime",
      pitEvents: pitSignals ? `${gameId}-pit-transition` : null,
      positionChanges: positionChanges ? "TelemetryPacket.RacePosition at lap boundaries" : null,
      tyreStrategy: tyreStrategy == null ? null : "initial-compound-only",
      fuelStrategy: fuelStrategy == null ? null : "initial-acc.fuelPerLap-only",
      resultReason: f1?.resultReason == null ? null : "f1.finalClassification.resultReason",
    },
  });
  const classificationClaims: RaceResultClaimEvidence<ResultClassification>[] = (f1?.classificationClaims ?? []).map((claim) => ({
    id: `classification:${claim.source}:${claim.sequence}`,
    claimId: "race-result.classification",
    entityId: `${gameId}:player`,
    validFrom: 0,
    validTo: Number.MAX_SAFE_INTEGER,
    value: claim.classification,
    authority: resolveRaceResultAuthorityFromSourceStatus(claim.source === "final-classification" ? "direct" : "simplified"),
    kind: "deterministic",
    confidence: claim.source === "final-classification" ? 1 : 0.7,
    observedAt: claim.observedAt,
    valid: true,
    applicable: true,
    validated: true,
    provenance,
  }));
  return {
    gameId,
    sessionType,
    classification,
    finishingPosition,
    qualifyingPosition,
    isFastestLap,
    fastestLapSource: f1 ? "f1-grid" : null,
    packets,
    claims: classificationClaims,
    pitEvents: pitSignals ? derivePitLedger(pitSignals) : undefined,
    positionChanges,
    tyreStrategy,
    fuelStrategy,
    provenance,
    evidence: { fieldStatus, conflicts: f1?.conflicts ?? [] },
    reasons: [],
  };
}
