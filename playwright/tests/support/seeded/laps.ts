import { expect, type APIRequestContext } from "@playwright/test";
import type { GameId } from "../../../../shared/games/ids";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

interface SeededLapListItem {
  id: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
  isValid: boolean;
}

export interface SeededLapTarget extends SeededLapListItem {
  telemetry: TelemetryPacket[];
}

export async function getSeededLapTarget(request: APIRequestContext, gameId: GameId): Promise<SeededLapTarget> {
  const listResponse = await request.get(`/api/laps?gameId=${gameId}`);
  expect(listResponse.ok(), `${gameId} seeded lap list`).toBe(true);
  const laps = (await listResponse.json()) as SeededLapListItem[];
  const selected = laps.find((lap) => lap.isValid);
  expect(selected, `${gameId} needs one valid seeded lap`).toBeDefined();
  const telemetryResponse = await request.get(`/api/laps/${selected!.id}`, { headers: { "X-Game-Id": gameId } });
  expect(telemetryResponse.ok(), `${gameId} seeded lap telemetry`).toBe(true);
  const payload = (await telemetryResponse.json()) as { telemetry?: TelemetryPacket[] };
  expect(payload.telemetry?.length, `${gameId} seeded lap packet count`).toBeGreaterThan(10);
  return { ...selected!, telemetry: payload.telemetry! };
}
