import type { TelemetryPacket } from "./types";
import type { TelemetryTimestamp } from "./resolver/contracts";

type LmuNativeFrame = TelemetryPacket | { readonly packet: TelemetryPacket };

const SCORING_PACKET_FIELDS: Readonly<Record<string, true>> = {
  "TelemetryPacket.AirTemp": true,
  "TelemetryPacket.TrackTemp": true,
  "TelemetryPacket.RainPercent": true,
  "TelemetryPacket.WeatherType": true,
  "TelemetryPacket.IsRaceOn": true,
  "TelemetryPacket.RacePosition": true,
  "TelemetryPacket.BestLap": true,
  "TelemetryPacket.LastLap": true,
  "TelemetryPacket.DistanceTraveled": true,
};

const SCORING_LMU_FIELDS: Readonly<Record<string, true>> = {
  "lmu.averagePathWetness": true,
  "lmu.bestSector1": true,
  "lmu.bestSector2": true,
  "lmu.cloudCoverage": true,
  "lmu.control": true,
  "lmu.countLapFlag": true,
  "lmu.currentSector1": true,
  "lmu.currentSector2": true,
  "lmu.darkCloud": true,
  "lmu.finishStatus": true,
  "lmu.gamePhase": true,
  "lmu.inGarageStall": true,
  "lmu.inPits": true,
  "lmu.lapDistanceM": true,
  "lmu.lapDistancePct": true,
  "lmu.lastSector1": true,
  "lmu.lastSector2": true,
  "lmu.maximumPathWetness": true,
  "lmu.minimumPathWetness": true,
  "lmu.penaltyCount": true,
  "lmu.pitState": true,
  "lmu.pitStopCount": true,
  "lmu.primaryFlag": true,
  "lmu.rainIntensity": true,
  "lmu.sectorFlags": true,
  "lmu.sessionType": true,
  "lmu.sessionTypeOrdinal": true,
  "lmu.trackGripLevel": true,
  "lmu.underYellow": true,
  "lmu.wind": true,
  "lmu.yellowFlagState": true,
};

function sessionTimestamp(seconds: number | undefined): TelemetryTimestamp | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = seconds * 1_000;
  return Number.isFinite(milliseconds) ? { domain: "session", milliseconds } : null;
}

export function lmuTelemetryTimestamp(native: LmuNativeFrame): TelemetryTimestamp | null | undefined {
  const packet = "packet" in native ? native.packet : native;
  if (packet.gameId !== "lmu") return undefined;
  if (!packet.lmu) return null;
  return sessionTimestamp(packet.lmu.telemetryElapsedTime);
}

export function lmuSourceTimestamp(native: LmuNativeFrame, sourceChannel: string): TelemetryTimestamp | null | undefined {
  const packet = "packet" in native ? native.packet : native;
  if (packet.gameId !== "lmu") return undefined;
  if (!packet.lmu) return null;
  const scoringBacked = sourceChannel.startsWith("LMU.ScoringInfo.") ||
    sourceChannel.startsWith("LMU.PlayerScoring.") ||
    SCORING_PACKET_FIELDS[sourceChannel] === true ||
    SCORING_LMU_FIELDS[sourceChannel] === true;
  return sessionTimestamp(scoringBacked ? packet.lmu.scoringElapsedTime : packet.lmu.telemetryElapsedTime);
}
