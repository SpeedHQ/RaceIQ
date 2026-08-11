import { summariseLapStyle, type LapStyleSummary } from "../../shared/racing/analysis/laps/driving-style";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { GameId } from "../../shared/games/ids";
import { evaluateGroupEligibility, isEligibilityUsable, selectDriverProfileEligibleLaps } from "../../shared/racing/quality/policies";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { getLapMetaForProfileScope, getLapsByIds } from "../db/lap-read-queries";
import { buildDriverFingerprint, emptyFingerprint, type DriverFingerprint, type ProfileScope } from "./fingerprint";
import { buildDriverTrend, DRIVER_TREND_WINDOW_LAPS } from "./trend";

/** Minimum decoded frames for a lap to be worth running detectors over. */
const MIN_TELEMETRY_FRAMES = 30;

/** Load and reduce all driver laps for one selected game to a global fingerprint. */
export async function loadDriverProfile(opts: { gameId: GameId }): Promise<DriverFingerprint> {
  const scope: ProfileScope = { kind: "global", gameId: opts.gameId, carOrdinal: null, trackOrdinal: null };
  const pool = await getLapMetaForProfileScope(opts.gameId);
  const groupPool = pool.flatMap((lap) =>
    lap.quality && lap.eligibility
      ? [
          {
            lapId: lap.id,
            lapTime: lap.lapTime,
            createdAt: lap.createdAt,
            carTrackKey: `${lap.gameId ?? opts.gameId}:${lap.carOrdinal ?? "unknown"}:${lap.trackOrdinal ?? "unknown"}`,
            quality: lap.quality,
            eligibility: lap.eligibility,
          },
        ]
      : [],
  );
  const profileDecision = evaluateGroupEligibility("driver-profile", groupPool);
  const selectedIds = new Set(selectDriverProfileEligibleLaps(groupPool).map((lap) => lap.lapId));
  const candidates = isEligibilityUsable(profileDecision) ? pool.filter((lap) => selectedIds.has(lap.id)) : [];
  const trend = buildDriverTrend(pool);
  if (candidates.length === 0) {
    return {
      ...emptyFingerprint(scope, { candidates: 0 }, ["No policy-eligible laps recorded for this scope."], trend),
      eligibility: profileDecision,
    };
  }

  const selected = candidates.slice(0, DRIVER_TREND_WINDOW_LAPS);
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
    perLapInsights.push(analyzeLap(lap.telemetry, lapGame, meta.quality));
    perLapStyle.push(summariseLapStyle(lap.telemetry, lapGame));
  }

  return buildDriverFingerprint({
    scope,
    laps,
    perLapInsights,
    perLapStyle,
    trend,
    eligibility: profileDecision,
    pool: { candidates: candidates.length, droppedNoTelemetry },
  });
}
