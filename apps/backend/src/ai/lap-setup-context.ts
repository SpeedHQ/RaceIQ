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
  carOrdinal: number;
  trackOrdinal: number | null;
  settings: unknown;
}

export async function linkedTuneSetupForLap(
  lap: { tuneId?: number | null; gameId?: string; carOrdinal?: number | null; trackOrdinal?: number | null },
  readTune: typeof getTuneById = getTuneById,
): Promise<LinkedLapTuneSetup | undefined> {
  if (lap.tuneId == null || lap.gameId !== "ac-evo" || lap.carOrdinal == null) return undefined;
  const tune = await readTune(lap.tuneId);
  if (!tune || tune.gameId !== lap.gameId || tune.carOrdinal !== lap.carOrdinal ||
    (tune.trackOrdinal != null && tune.trackOrdinal !== lap.trackOrdinal)) return undefined;
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
    carOrdinal: tune.carOrdinal,
    trackOrdinal: tune.trackOrdinal,
    settings,
  };
}

export function setupContextForLap(
  lap: {
    id: number;
    gameId?: GameId;
    carOrdinal?: number;
    trackOrdinal?: number | null;
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
  const carModel = typeof game?.getCarName === "function" && lap.carOrdinal != null ? game.getCarName(lap.carOrdinal) : undefined;
  const trackName = typeof game?.getTrackName === "function" && lap.trackOrdinal != null
    ? game.getTrackName(lap.trackOrdinal)
    : undefined;
  const f1Setup = gameId === "f1-2025" ? resolveLapF1Setup(lap) : null;
  const tuneMatchesLap = gameId === "ac-evo" && linkedTune != null && lap.carOrdinal != null &&
    linkedTune.gameId === gameId && linkedTune.carOrdinal === lap.carOrdinal &&
    (linkedTune.trackOrdinal == null || linkedTune.trackOrdinal === lap.trackOrdinal);
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
