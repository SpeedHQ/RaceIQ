import { createHash } from "node:crypto";
import { resolveLapF1Setup } from "@raceiq/backend-core/ai/f1-setup-identity";
import { getTuneById } from "@raceiq/backend-core/db/tune-queries";
import type { GameAdapter } from "@raceiq/shared/games/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";

import { normalizeAcEvoTuneSettings } from "@raceiq/shared/racing/setups/schema";
export interface LinkedLapTuneSetup {
  id: number;
  gameId: string;
  carId: string;
  trackId: string | null;
  settings: unknown;
}

export async function linkedTuneSetupForLap(
  lap: { tuneId?: number | null; gameId?: string; carId?: string | null; trackId?: string | null },
  readTune: typeof getTuneById = getTuneById,
): Promise<LinkedLapTuneSetup | undefined> {
  if (lap.tuneId == null || lap.gameId !== "ac-evo" || lap.carId == null) return undefined;
  const tune = await readTune(lap.tuneId);
  if (!tune || tune.gameId !== lap.gameId || tune.carId !== lap.carId ||
    (tune.trackId != null && tune.trackId !== lap.trackId)) return undefined;
  let settings: unknown = tune.settings;
  if (typeof settings === "string") {
    try {
      settings = JSON.parse(settings);
    } catch {
      settings = undefined;
    }
  }
  return {
    id: tune.id,
    gameId: tune.gameId,
    carId: tune.carId,
    trackId: tune.trackId,
    settings,
  };
}

export function setupContextForLap(
  lap: {
    id: number;
    gameId?: GameId;
    carId?: string | null;
    trackId?: string | null;
    carSetup?: string | null;
    telemetry: TelemetryPacket[];
  },
  resolveGame: typeof getGame = getGame,
  linkedTune?: LinkedLapTuneSetup,
) {
  let game: GameAdapter | undefined;
  if (lap.gameId) {
    try {
      game = resolveGame(lap.gameId);
    } catch {
      game = undefined;
    }
  }
  const gameId = lap.gameId;
  const carModel = typeof game?.getCarName === "function" && lap.carId != null ? game.getCarName(lap.carId) : undefined;
  const trackName = typeof game?.getTrackName === "function" && lap.trackId != null
    ? game.getTrackName(lap.trackId)
    : undefined;
  const f1Setup = gameId === "f1-2025" ? resolveLapF1Setup(lap) : null;
  const tuneMatchesLap = gameId === "ac-evo" && linkedTune != null && lap.carId != null &&
    linkedTune.gameId === gameId && linkedTune.carId === lap.carId &&
    (linkedTune.trackId == null || linkedTune.trackId === lap.trackId);
  const tuneValues: Record<string, number> = {};
  if (linkedTune && tuneMatchesLap && linkedTune.settings && typeof linkedTune.settings === "object") {
    const normalized = normalizeAcEvoTuneSettings(linkedTune.settings as Record<string, unknown>);
    for (const key of [
      "frontARB", "rearARB", "brakeBias", "frontRideHeight", "rearRideHeight",
      "frontWing", "rearWing", "diffPreload", "frontLeftBump", "frontRightBump", "rearLeftBump",
      "rearRightBump", "frontLeftRebound", "frontRightRebound", "rearLeftRebound",
      "rearRightRebound",
    ]) {
      const value = normalized[key];
      if (typeof value === "number" && Number.isFinite(value)) tuneValues[key] = value;
    }
  }
  const setupSnapshot = f1Setup ?? (Object.keys(tuneValues).length ? tuneValues : undefined);
  const setupVersion = f1Setup
    ? createHash("sha256").update(JSON.stringify(f1Setup)).digest("hex")
    : linkedTune && tuneMatchesLap && Object.keys(tuneValues).length
      ? `tune:${linkedTune.id}:${createHash("sha256").update(JSON.stringify(tuneValues)).digest("hex")}`
      : undefined;
  return { gameId, carModel, trackName, setupSnapshot, setupVersion, lapId: lap.id };
}
