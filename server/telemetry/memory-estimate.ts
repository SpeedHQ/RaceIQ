import type { TelemetryPacket } from "../../shared/telemetry/types";

const F1_PACKET_BYTES = 12_000;
const ACC_PACKET_BYTES = 800;
const BASE_PACKET_BYTES = 500;

export function estimateTelemetryPacketBytes(packet: TelemetryPacket): number {
  if (packet.f1) return F1_PACKET_BYTES;
  if (packet.acc) return ACC_PACKET_BYTES;
  return BASE_PACKET_BYTES;
}

export function estimateTelemetryPacketsBytes(packets: TelemetryPacket[]): number {
  return packets.reduce((total, packet) => total + estimateTelemetryPacketBytes(packet), 0);
}
