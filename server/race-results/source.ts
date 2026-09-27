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

function pitStatus(gameId: GameId, packet: TelemetryPacket): boolean | null {
  if (gameId === "acc" || gameId === "ac-evo") return (packet.acc?.pitStatus ?? "out") !== "out";
  if (gameId === "f1-2025") return packet.f1?.pitLaneTimerActive === 1;
  if (gameId === "iracing") return packet.iracing?.onPitRoad === true;
  if (gameId === "lmu") return packet.lmu?.inPits === true;
  return null;
}

function pitSource(gameId: GameId, packet: TelemetryPacket): Record<string, unknown> {
  if (gameId === "acc" || gameId === "ac-evo") return { channel: "acc.pitStatus", value: packet.acc?.pitStatus ?? "out" };
  if (gameId === "f1-2025") return { channel: "f1.pitLaneTimerActive", value: 1 };
  if (gameId === "iracing") return { channel: "iracing.onPitRoad", value: true };
  return { channel: "lmu.inPits", value: true };
}

export class RaceSourceAccumulator {
  private packetCount = 0;
  private pitSignals: PitServiceSignals[] | undefined;
  private inPit = false;
  private sessionType: string | null = null;
  private livePosition: number | null = null;
  private finalPosition: number | null = null;
  private liveGridPosition: number | null = null;
  private finalGridPosition: number | null = null;
  private finalClassification: ResultClassification | null = null;
  private liveClassification: ResultClassification | null = null;
  private finalClassifications = new Set<ResultClassification>();
  private liveClassifications = new Set<ResultClassification>();
  private sessionTypes = new Map<string, string>();
  private classificationClaims: Array<{ classification: ResultClassification; source: "final-classification" | "lap-data"; observedAt: number; sequence: number }> = [];
  private resultReason: number | null = null;
  private isFastestLap: boolean | null = null;
  private tyreStrategy: unknown = null;
  private fuelPerLap: number | null = null;
  private lapPositions = new Map<number, number>();

  private readonly gameId: GameId;

  constructor(gameId: GameId) {
    this.gameId = gameId;
  }

  add(packet: TelemetryPacket): void {
    const index = this.packetCount++;
    const inPit = pitStatus(this.gameId, packet);
    if (inPit !== null) {
      this.pitSignals ??= [];
      if (inPit && !this.inPit) {
        this.pitSignals.push({
          lapNumber: packet.LapNumber, elapsedSeconds: packet.CurrentRaceTime,
          linkage: "linked", source: pitSource(this.gameId, packet),
        });
      }
      this.inPit = inPit;
    }

    const position = positive(packet.RacePosition);
    if (position != null) this.livePosition = position;
    if (packet.LapNumber != null && packet.LapNumber > 0 && packet.RacePosition != null && packet.RacePosition > 0) {
      this.lapPositions.set(packet.LapNumber, packet.RacePosition);
    }
    const compound = packet.f1?.tyreCompound ?? packet.acc?.tireCompound;
    if (this.tyreStrategy == null && compound != null && compound !== "") this.tyreStrategy = compound;
    const fuel = packet.acc?.fuelPerLap;
    if (this.fuelPerLap == null && fuel != null && Number.isFinite(fuel) && fuel > 0) this.fuelPerLap = fuel;

    if (this.gameId === "f1-2025") {
      const f1 = packet.f1;
      if (f1?.sessionType && f1.sessionType !== "unknown") {
        this.sessionType = f1.sessionType;
        this.sessionTypes.set(f1.sessionType.trim().toLowerCase(), f1.sessionType);
      }
      const observedClassification = classifyF1Result(f1?.resultStatus);
      if (observedClassification) {
        const observedAt = packet.TimestampMS ?? packet.CurrentRaceTime * 1000;
        const source = f1?.resultSource === "final-classification" ? "final-classification" : "lap-data";
        this.classificationClaims.push({
          classification: observedClassification, source,
          observedAt: Number.isFinite(observedAt) ? observedAt : index, sequence: index,
        });
        if (source === "final-classification") {
          this.finalClassifications.add(observedClassification);
          this.finalClassification = observedClassification;
          this.finalPosition = position;
          this.finalGridPosition = positive(f1?.gridPosition);
          this.resultReason = f1?.resultReason ?? null;
        } else {
          this.liveClassifications.add(observedClassification);
          this.liveClassification = observedClassification;
        }
      }
      this.liveGridPosition = positive(f1?.gridPosition) ?? this.liveGridPosition;
      const bestLap = positive(packet.BestLap);
      if (bestLap != null && f1?.grid) {
        let gridBest: number | null = null;
        for (const entry of f1.grid) {
          const candidate = positive(entry.bestLapTime);
          if (candidate != null && (gridBest == null || candidate < gridBest)) gridBest = candidate;
        }
        if (gridBest != null) this.isFastestLap = bestLap <= gridBest;
      }
    } else if (packet.acc?.acEvo?.sessionType && packet.acc.acEvo.sessionType !== "unknown") {
      this.sessionType = packet.acc.acEvo.sessionType;
    }
  }

  finish(): RaceSourceObservation {
    const f1 = this.gameId === "f1-2025";
    const classification = f1 ? this.finalClassification ?? this.liveClassification : null;
    const classificationSource = this.finalClassification ? "final-classification" : this.liveClassification ? "lap-data" : null;
    const finishingPosition = this.finalPosition ?? this.livePosition;
    const qualifyingPosition = this.finalGridPosition ?? this.liveGridPosition;
    const tyreStrategy = this.tyreStrategy;
    const fuelStrategy = this.fuelPerLap == null ? null : { fuelPerLap: this.fuelPerLap };
    const pitSignals = this.pitSignals;
    const fieldStatus: RaceResultEvidence["fieldStatus"] = {
      sessionType: status(this.sessionType != null, "direct"),
      classification: status(classification != null, classificationSource === "final-classification" ? "direct" : "simplified"),
      finishingPosition: status(finishingPosition != null, this.finalPosition != null ? "direct" : "simplified"),
      qualifyingPosition: status(qualifyingPosition != null, this.finalGridPosition != null ? "direct" : "simplified"),
      isPodium: "unavailable",
      isFastestLap: status(this.isFastestLap != null, "derived"),
      pitEvents: status(pitSignals != null, "derived"),
      tyreStrategy: status(tyreStrategy != null, "simplified"),
      fuelStrategy: status(fuelStrategy != null, "simplified"),
    };
    const lapPositions = [...this.lapPositions.entries()].sort(([a], [b]) => a - b);
    const changes = [];
    let previousPosition: number | null = null;
    for (const [lapNumber, position] of lapPositions) {
      if (previousPosition != null && position !== previousPosition) {
        changes.push({
          eventType: "position-change" as const, sequence: 100000 + lapNumber,
          lapNumber, elapsedSeconds: null, durationSeconds: null, service: "unknown" as const,
          tyreChange: null, fuelAdded: null, fuelBefore: null, fuelAfter: null,
          positionBefore: previousPosition, positionAfter: position,
          linkage: "linked" as const, source: { telemetry: "RacePosition", boundary: "lap-end" },
        });
      }
      previousPosition = position;
    }
    const positionChanges = changes.length ? changes : undefined;
    const conflicts: string[] = [];
    const classifications = this.finalClassifications.size ? this.finalClassifications : this.liveClassifications;
    if (f1 && classifications.size > 1) conflicts.push(`classification:${[...classifications].join("|")}`);
    if (f1 && this.sessionTypes.size > 1) conflicts.push(`session-type:${[...this.sessionTypes.values()].join("|")}`);
    const provenance = createRaceResultProvenance(this.gameId, {
      extractor: SOURCE_EXTRACTOR,
      fields: {
        sessionType: fieldStatus.sessionType === "direct" ? (f1 ? "f1.sessionType" : "acc.acEvo.sessionType") : null,
        classification: classification == null ? null : `f1.resultStatus:${classificationSource ?? "unknown"}`,
        finishingPosition: finishingPosition == null ? null : `TelemetryPacket.RacePosition:${this.finalPosition != null ? "final-classification" : f1 ? "lap-data" : "continuous"}`,
        qualifyingPosition: qualifyingPosition == null ? null : `f1.gridPosition:${this.finalGridPosition != null ? "final-classification" : "lap-data"}`,
        isFastestLap: this.isFastestLap == null ? null : "player-vs-f1.grid.bestLapTime",
        pitEvents: pitSignals ? `${this.gameId}-pit-transition` : null,
        positionChanges: positionChanges ? "TelemetryPacket.RacePosition at lap boundaries" : null,
        tyreStrategy: tyreStrategy == null ? null : "initial-compound-only",
        fuelStrategy: fuelStrategy == null ? null : "initial-acc.fuelPerLap-only",
        resultReason: this.resultReason == null ? null : "f1.finalClassification.resultReason",
      },
    });
    const claims: RaceResultClaimEvidence<ResultClassification>[] = this.classificationClaims.map((claim) => ({
      id: `classification:${claim.source}:${claim.sequence}`,
      claimId: "race-result.classification",
      entityId: `${this.gameId}:player`,
      validFrom: 0, validTo: Number.MAX_SAFE_INTEGER, value: claim.classification,
      authority: resolveRaceResultAuthorityFromSourceStatus(claim.source === "final-classification" ? "direct" : "simplified"),
      kind: "deterministic", confidence: claim.source === "final-classification" ? 1 : 0.7,
      observedAt: claim.observedAt, valid: true, applicable: true, validated: true, provenance,
    }));
    return {
      gameId: this.gameId, sessionType: this.sessionType, classification,
      finishingPosition, qualifyingPosition, isFastestLap: this.isFastestLap,
      fastestLapSource: f1 ? "f1-grid" : null, claims,
      pitEvents: pitSignals ? derivePitLedger(pitSignals) : undefined,
      positionChanges, tyreStrategy, fuelStrategy, provenance,
      evidence: { fieldStatus, conflicts }, reasons: [],
    };
  }
}
function status(available: boolean, availableStatus: RaceResultSourceStatus): RaceResultSourceStatus {
  return available ? availableStatus : "unavailable";
}

export function extractRaceSource(gameId: GameId, packets: TelemetryPacket[]): RaceSourceObservation {
  const accumulator = new RaceSourceAccumulator(gameId);
  for (const packet of packets) accumulator.add(packet);
  return accumulator.finish();
}
