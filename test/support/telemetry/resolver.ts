import type { GameId } from "../../../shared/games/ids";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

export function packet(
  gameId: GameId,
  values: Partial<TelemetryPacket> = {},
): TelemetryPacket {
  return {
    gameId,
    TimestampMS: 1_000,
    Speed: 42,
    IsRaceOn: 1,
    Fuel: 0.5,
    FuelCapacity: 0,
    ...values,
  } as TelemetryPacket;
}
