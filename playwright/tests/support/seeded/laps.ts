import { expect, type APIRequestContext } from "@playwright/test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";

interface SeededLapListItem {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
  isValid: boolean;
  carSetup: LapMeta["carSetup"];
}

export interface SeededLapTarget extends SeededLapListItem {
  telemetry: TelemetryPacket[];
}

export async function getSeededLapMeta(request: APIRequestContext, gameId: GameId): Promise<SeededLapListItem> {
  const listResponse = await request.get(`/api/laps?gameId=${gameId}`);
  expect(listResponse.ok(), `${gameId} seeded lap list`).toBe(true);
  const laps = (await listResponse.json()) as SeededLapListItem[];
  // Some checked-in recordings intentionally contain only invalid complete
  // laps. They still provide the telemetry needed by route/UI coverage.
  const selected =
    laps.find((lap) => lap.isValid) ??
    laps.filter((lap) => lap.lapTime > 10).sort((a, b) => b.lapNumber - a.lapNumber || b.id - a.id)[0];
  expect(selected, `${gameId} needs one usable seeded lap`).toBeDefined();
  return selected!;
}

export async function getSeededLapTarget(request: APIRequestContext, gameId: GameId): Promise<SeededLapTarget> {
  const selected = await getSeededLapMeta(request, gameId);
  const telemetryResponse = await request.get(`/api/laps/${selected.id}`, { headers: { "X-Game-Id": gameId } });
  expect(telemetryResponse.ok(), `${gameId} seeded lap telemetry`).toBe(true);
  const payload = (await telemetryResponse.json()) as { telemetry?: TelemetryPacket[] };
  expect(payload.telemetry?.length, `${gameId} seeded lap packet count`).toBeGreaterThan(10);
  return { ...selected!, telemetry: payload.telemetry! };
}
