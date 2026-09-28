import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { LapInsight } from "./types";

/** Prepare recorded frames for analysis without changing the original lap. */
export function processLap(telemetry: TelemetryPacket[], gameId: GameId): { packets: TelemetryPacket[]; sourceIndices?: number[] } {
  if (gameId !== "f1-2025" && gameId !== "acc" && gameId !== "ac-evo") return { packets: telemetry };
  const sameTick = gameId === "f1-2025"
    ? (packet: TelemetryPacket, last: TelemetryPacket) =>
      packet.TimestampMS === last.TimestampMS && packet.sessionUID === last.sessionUID
    : (packet: TelemetryPacket, last: TelemetryPacket) =>
      Number.isFinite(packet.CurrentLap) && packet.CurrentLap === last.CurrentLap;
  // Kunos acquisition can outpace simulator-time updates. Zero-duration
  // snapshots split sustained detector events; keep last update for each tick.
  if (!telemetry.some((packet, i) => i > 0 && sameTick(packet, telemetry[i - 1]))) {
    return { packets: telemetry };
  }

  const packets: TelemetryPacket[] = [];
  const sourceIndices: number[] = [];
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const last = packets[packets.length - 1];
    if (last && sameTick(packet, last)) {
      packets[packets.length - 1] = packet;
      sourceIndices[sourceIndices.length - 1] = i;
    } else {
      packets.push(packet);
      sourceIndices.push(i);
    }
  }
  return { packets, sourceIndices };
}

/** Translate insight indices from coalesced frames back to original packet positions. */
export function restoreFrameIndices(insights: LapInsight[], sourceIndices: number[] | undefined): void {
  if (!sourceIndices) return;
  for (const insight of insights) insight.frameIndices = insight.frameIndices.map((index) => sourceIndices[index]);
}
