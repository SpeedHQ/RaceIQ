import type { GameId } from "../../../../games/ids";
import type { TelemetryPacket } from "../../../../telemetry/types";
import type { LapInsight } from "./types";

/** Prepare recorded frames for analysis without changing the original lap. */
export function processLap(telemetry: TelemetryPacket[], gameId: GameId): { packets: TelemetryPacket[]; sourceIndices?: number[] } {
  return gameId === "f1-2025" ? coalesceF1Frames(telemetry) : { packets: telemetry };
}

/** Keep the last snapshot of each consecutive same-tick update within a session. */
function coalesceF1Frames(telemetry: TelemetryPacket[]): { packets: TelemetryPacket[]; sourceIndices?: number[] } {
  if (!telemetry.some((packet, i) => i > 0 && packet.TimestampMS === telemetry[i - 1].TimestampMS && packet.sessionUID === telemetry[i - 1].sessionUID)) {
    return { packets: telemetry };
  }

  const packets: TelemetryPacket[] = [];
  const sourceIndices: number[] = [];
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const last = packets[packets.length - 1];
    if (last && packet.TimestampMS === last.TimestampMS && packet.sessionUID === last.sessionUID) {
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
export function restoreF1FrameIndices(insights: LapInsight[], sourceIndices: number[] | undefined): void {
  if (!sourceIndices) return;
  for (const insight of insights) insight.frameIndices = insight.frameIndices.map((index) => sourceIndices[index]);
}
