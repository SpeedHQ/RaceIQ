import { summariseLapStyle, type LapStyleSummary } from "../../shared/lib/driving-style";
import { analyzeLap, type LapInsight } from "../../shared/lib/lap-insights";
import type { GameId, LapMeta } from "../../shared/types";
import { getLapMetaForProfileScope, getLapsByIds } from "../db/lap-read-queries";
import { buildDriverFingerprint, emptyFingerprint, type DriverFingerprint, type ProfileScope } from "./fingerprint";
import { buildDriverTrend, DRIVER_TREND_WINDOW_LAPS } from "./trend";

/** Minimum decoded frames for a lap to be worth running detectors over. */
const MIN_TELEMETRY_FRAMES = 30;

/** Load and reduce all driver laps for one selected game to a global fingerprint. */
export async function loadDriverProfile(opts: { gameId: GameId }): Promise<DriverFingerprint> {
  const scope: ProfileScope = { kind: "global", gameId: opts.gameId, carOrdinal: null, trackOrdinal: null };
  const pool = await getLapMetaForProfileScope(opts.gameId);
  const trend = buildDriverTrend(pool);
  if (pool.length === 0) {
    return emptyFingerprint(scope, { candidates: 0 }, ["No laps recorded for this scope."], trend);
  }

  const selected = pool.slice(0, DRIVER_TREND_WINDOW_LAPS);
  const loaded = await getLapsByIds(selected.map((lap) => lap.id));
  const metaById = new Map(selected.map((lap) => [lap.id, lap]));
  const laps: LapMeta[] = [];
  const perLapInsights: LapInsight[][] = [];
  const perLapStyle: LapStyleSummary[] = [];
  let droppedNoTelemetry = selected.length - loaded.length;

  for (const lap of loaded) {
    const meta = metaById.get(lap.id);
    if (!meta || lap.parseError || lap.telemetry.length < MIN_TELEMETRY_FRAMES) {
      droppedNoTelemetry++;
      continue;
    }
    const lapGame = meta.gameId ?? opts.gameId;
    laps.push(meta);
    perLapInsights.push(analyzeLap(lap.telemetry, lapGame));
    perLapStyle.push(summariseLapStyle(lap.telemetry, lapGame));
  }

  return buildDriverFingerprint({
    scope,
    laps,
    perLapInsights,
    perLapStyle,
    trend,
    pool: { candidates: pool.length, droppedNoTelemetry },
  });
}
