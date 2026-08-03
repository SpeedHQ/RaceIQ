import type { RaceResultClaimEvidence, RaceResultEvidence, RaceResultSourceStatus } from "../../shared/race-results/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { derivePitLedger, type PitServiceSignals } from "./pit-ledger";
import type { RaceSourceObservation, ResultClassification } from "./types";
import { createRaceResultProvenance } from "./provenance";
import { resolveRaceResultAuthorityFromSourceStatus } from "./authority";

function classifyF1Result(status: number | undefined): ResultClassification | null {
  switch (status) {
    case 3:
      return "finished";
    case 4:
    case 5:
    case 6:
      return "dnf";
    case 7:
      return "retired";
    default:
      return null;
  }
}

function last<T>(packets: TelemetryPacket[]): T | null {
  return packets.length > 0 ? (packets[packets.length - 1] as T) : null;
}

function extractPitSignals(packets: TelemetryPacket[]): PitServiceSignals[] | undefined {
  if (packets.length === 0) return undefined;
  const gameId = packets[0].gameId;
  if (gameId === "acc" || gameId === "ac-evo") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const status = packet.acc?.pitStatus ?? "out";
      const nextInPit = status !== "out";
      if (nextInPit && !inPit) {
        signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { pitStatus: status } });
      }
      inPit = nextInPit;
    }
    return signals;
  }
  if (gameId === "f1-2025") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const nextInPit = packet.f1?.pitLaneTimerActive === 1;
      if (nextInPit && !inPit) {
        signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { pitLaneTimerActive: 1 } });
      }
      inPit = nextInPit;
    }
    return signals;
  }
  if (gameId === "iracing") {
    const signals: PitServiceSignals[] = [];
    let inPit = false;
    for (const packet of packets) {
      const nextInPit = packet.iracing?.onPitRoad === true;
      if (nextInPit && !inPit) signals.push({ lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime, linkage: "linked", source: { onPitRoad: true } });
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
  const classificationClaims: Array<{
    classification: ResultClassification;
    source: "final-classification" | "lap-data";
    observedAt: number;
    sequence: number;
  }> = [];

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
      classificationClaims.push({
        classification: observedClassification,
        source: claimSource,
        observedAt: Number.isFinite(observedAt) ? observedAt : packetIndex,
        sequence: packetIndex,
      });
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
  const selectedClassifications =
    finalClassifications.size > 0 ? finalClassifications : liveClassifications;
  if (selectedClassifications.size > 1) {
    conflicts.push(`classification:${[...selectedClassifications].join("|")}`);
  }
  if (sessionTypes.size > 1) {
    conflicts.push(`session-type:${[...sessionTypes.values()].join("|")}`);
  }
  return {
    sessionType: f1?.sessionType,
    classification: classifyF1Result(f1?.resultStatus),
    finishingPosition: playerPosition,
    qualifyingPosition: f1?.gridPosition && f1.gridPosition > 0 ? f1.gridPosition : null,
    isFastestLap,
    classificationClaims,
    conflicts,
  };
}

export function extractRaceSource(gameId: GameId, packets: TelemetryPacket[]): RaceSourceObservation {
  const lastPacket = packets.at(-1);
  const firstPacket = packets[0];
  const pitSignals = extractPitSignals(packets);
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
  const provenance = createRaceResultProvenance(gameId, {
    extractor: SOURCE_EXTRACTOR,
    fields: {
      sessionType: fieldStatus.sessionType === "direct" ? (gameId === "f1-2025" ? "f1.sessionType" : "acc.acEvo.sessionType") : null,
      classification: classification == null ? null : `f1.resultStatus:${f1?.classificationSource ?? "unknown"}`,
      finishingPosition: finishingPosition == null ? null : `TelemetryPacket.RacePosition:${f1?.finishingPositionSource ?? "continuous"}`,
      qualifyingPosition: qualifyingPosition == null ? null : `f1.gridPosition:${f1?.qualifyingPositionSource ?? "unknown"}`,
      isFastestLap: isFastestLap == null ? null : "player-vs-f1.grid.bestLapTime",
      pitEvents: pitSignals ? `${gameId}-pit-transition` : null,
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
    packets,
    claims: classificationClaims,
    pitEvents: pitSignals ? derivePitLedger(pitSignals) : undefined,
    tyreStrategy,
    fuelStrategy,
    provenance,
    evidence: {
      fieldStatus,
      conflicts: f1?.conflicts ?? [],
    },
    reasons: [],
  };
}
