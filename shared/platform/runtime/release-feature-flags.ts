import type { GameId } from "../../games/ids";

export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
  readonly liveSpotterEngineer: boolean;
  readonly liveSpotterEngineerGameIds: readonly GameId[];
}

export interface ReleaseFeatureFlagEnvironment {
  readonly RACEIQ_FEATURE_F1_EXPERIMENTS: string | undefined;
  readonly RACEIQ_FEATURE_IRACING_ADAPTER: string | undefined;
  readonly RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER?: string | undefined;
  readonly RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS?: string | undefined;
}

function booleanFlag(name: keyof ReleaseFeatureFlagEnvironment, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${name}: expected "true" or "false"`);
}

const SUPPORTED_VOICE_GAME_IDS: Readonly<Record<string, true>> = { acc: true };

function gameIdsFlag(value: string | undefined): readonly GameId[] {
  if (value === undefined) return [];
  const ids = value.split(",").map((id) => id.trim());
  if (ids.some((id) => id.length === 0)) throw new Error("Invalid RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: empty game ID");
  const deduped = [...new Set(ids)];
  for (const id of deduped) {
    if (SUPPORTED_VOICE_GAME_IDS[id] !== true) {
      throw new Error(`Invalid RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: unsupported game ID "${id}"`);
    }
  }
  return deduped as GameId[];
}

export function releaseFeatureFlags(env: ReleaseFeatureFlagEnvironment): ReleaseFeatureFlags {
  return {
    f1Experiments: booleanFlag("RACEIQ_FEATURE_F1_EXPERIMENTS", env.RACEIQ_FEATURE_F1_EXPERIMENTS),
    iracingAdapter: booleanFlag("RACEIQ_FEATURE_IRACING_ADAPTER", env.RACEIQ_FEATURE_IRACING_ADAPTER),
    liveSpotterEngineer: booleanFlag("RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER", env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER),
    liveSpotterEngineerGameIds: gameIdsFlag(env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS),
  };
}

export function isLiveSpotterEngineerEnabled(flags: ReleaseFeatureFlags, gameId: GameId): boolean {
  return flags.liveSpotterEngineer && flags.liveSpotterEngineerGameIds.includes(gameId);
}
