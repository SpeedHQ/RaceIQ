import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";


export function isAcEvoTouristLayout(
  packet: Pick<TelemetryPacket, "gameId" | "acEvoIdentity">,
): boolean {
  const identity = packet.acEvoIdentity;
  return packet.gameId === "ac-evo"
    && identity !== undefined
    && identity.trackName.trim().normalize("NFC").toLowerCase() === "nurburgring"
    && identity.trackConfiguration.trim().normalize("NFC").toLowerCase() === "touristenfahrten";
}
