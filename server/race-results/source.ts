import type { GameId, TelemetryPacket } from "../../shared/types";
import { derivePitLedger, type PitServiceSignals } from "./pit-ledger";
import type { RaceSourceObservation, ResultClassification } from "./types";

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

function extractF1Result(packets: TelemetryPacket[]) {
  const packet = last<TelemetryPacket>(packets);
  const f1 = packet?.f1;
  const grid = f1?.grid ?? [];
  const playerPosition = packet?.RacePosition && packet.RacePosition > 0 ? packet.RacePosition : null;
  const bestLap = packet?.BestLap && packet.BestLap > 0 ? packet.BestLap : null;
  const gridBest = grid.map((entry) => entry.bestLapTime).filter((time) => time > 0);
  const isFastestLap = bestLap != null && gridBest.length > 0 ? bestLap <= Math.min(...gridBest) : null;
  return {
    sessionType: f1?.sessionType,
    classification: classifyF1Result(f1?.resultStatus),
    finishingPosition: playerPosition,
    qualifyingPosition: f1?.gridPosition && f1.gridPosition > 0 ? f1.gridPosition : null,
    isFastestLap,
    provenance: {
      sessionType: "f1.sessionType",
      finishingPosition: "TelemetryPacket.RacePosition",
      qualifyingPosition: "f1.gridPosition",
      fastestLap: "player-vs-f1.grid.bestLapTime",
    },
  };
}

export function extractRaceSource(gameId: GameId, packets: TelemetryPacket[]): RaceSourceObservation {
  const lastPacket = packets.at(-1);
  const firstPacket = packets[0];
  const pitSignals = extractPitSignals(packets);
  const f1 = gameId === "f1-2025" ? extractF1Result(packets) : null;
  const sessionType = f1?.sessionType ?? firstPacket?.acc?.acEvo?.sessionType;
  const position = f1?.finishingPosition ?? (lastPacket?.RacePosition && lastPacket.RacePosition > 0 ? lastPacket.RacePosition : null);
  return {
    gameId,
    sessionType: sessionType ?? null,
    classification: f1?.classification ?? null,
    finishingPosition: position,
    qualifyingPosition: f1?.qualifyingPosition ?? null,
    isFastestLap: f1?.isFastestLap ?? null,
    fastestLapSource: f1 ? "f1-grid" : null,
    packets,
    pitEvents: pitSignals ? derivePitLedger(pitSignals) : undefined,
    positionChanges: extractPositionChanges(packets),
    tyreStrategy: firstPacket?.f1?.tyreCompound ?? firstPacket?.acc?.tireCompound ?? null,
    fuelStrategy: firstPacket?.acc ? { fuelPerLap: firstPacket.acc.fuelPerLap } : null,
    provenance: {
      ...(f1?.provenance ?? {}),
      pitLedger: pitSignals ? `${gameId}-pit-transition` : "unsupported",
      positionChanges: "TelemetryPacket.RacePosition at lap boundaries",
      tyreStrategy: firstPacket?.f1 ? "f1.tyreCompound" : firstPacket?.acc ? "acc.tireCompound" : "unknown",
      fuelStrategy: firstPacket?.acc ? "acc.fuelPerLap" : "unknown",
    },
    reasons: [],
  };
}
