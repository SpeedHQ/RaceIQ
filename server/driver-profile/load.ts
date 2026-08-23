import { summariseLapStyle, type LapStyleSummary } from "../../shared/racing/analysis/laps/driving-style";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { GameId } from "../../shared/games/ids";
import { evaluateGroupEligibility, isEligibilitySnapshotCurrent, isEligibilityUsable, selectDriverProfileEligibleLaps } from "../../shared/racing/quality/policies";
import type { EligibilityDecision } from "../../shared/racing/quality/contracts";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { getLapMetaForProfileScope } from "../db/lap-read-queries";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../shared/racing/analysis/laps/semantic-frame";
import { queryLapTelemetryBySemanticId } from "../telemetry/replay";
import { semanticSamplesFromReplay } from "../telemetry/semantic-samples";
import { buildDriverFingerprint, emptyFingerprint, type DriverFingerprint, type ProfileScope } from "./fingerprint";
import { buildDriverTrend, DRIVER_TREND_WINDOW_LAPS } from "./trend";

/** Minimum decoded frames for a lap to be worth running detectors over. */
const MIN_TELEMETRY_FRAMES = 30;
export function selectCurrentDriverProfileEvidence(pool: readonly LapMeta[], gameId: GameId): { currentPool: LapMeta[]; decision: EligibilityDecision; candidates: LapMeta[] } {
  const currentPool = pool.filter((lap) => isEligibilitySnapshotCurrent(lap, ["normal-pace", "lap-comparison"]) && !(lap.experimentExcluded && lap.experimentExcludedSource === "manual"));
  const groupPool = currentPool.flatMap((lap) =>
    lap.quality && lap.eligibility
      ? [
          {
            lapId: lap.id,
            lapTime: lap.lapTime,
            createdAt: lap.createdAt,
            carTrackKey: `${lap.gameId ?? gameId}:${lap.carOrdinal ?? "unknown"}:${lap.trackOrdinal ?? "unknown"}`,
            quality: lap.quality,
            eligibility: lap.eligibility,
          },
        ]
      : [],
  );
  const decision = evaluateGroupEligibility("driver-profile", groupPool);
  const selectedIds = new Set(selectDriverProfileEligibleLaps(groupPool).map((lap) => lap.lapId));
  const candidates = isEligibilityUsable(decision) ? currentPool.filter((lap) => selectedIds.has(lap.id)) : [];
  return { currentPool, decision, candidates };
}

/** Load and reduce all driver laps for one selected game to a global fingerprint. */
export async function loadDriverProfile(opts: { gameId: GameId }): Promise<DriverFingerprint> {
  const scope: ProfileScope = { kind: "global", gameId: opts.gameId, carOrdinal: null, trackOrdinal: null };
  const pool = await getLapMetaForProfileScope(opts.gameId);
  const { currentPool, decision: profileDecision, candidates } = selectCurrentDriverProfileEvidence(pool, opts.gameId);
  const trend = buildDriverTrend(currentPool);
  if (candidates.length === 0) {
    return {
      ...emptyFingerprint(scope, { candidates: 0 }, ["No policy-eligible laps recorded for this scope."], trend),
      ok: false,
      eligibility: profileDecision,
    };
  }

  const selected = candidates.slice(0, DRIVER_TREND_WINDOW_LAPS);
  const metaById = new Map(selected.map((lap) => [lap.id, lap]));
  const replays = await Promise.all(
    selected.map(async (lap) => ({
      lap,
      replay: await queryLapTelemetryBySemanticId(lap.id, CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS),
    })),
  );
  const laps: LapMeta[] = [];
  const perLapInsights: LapInsight[][] = [];
  const perLapStyle: LapStyleSummary[] = [];
  let droppedNoTelemetry = selected.length - replays.length;

  for (const { lap: selectedLap, replay } of replays) {
    const meta = metaById.get(selectedLap.id);
    if (!meta || !replay || replay.envelopes.length < MIN_TELEMETRY_FRAMES) {
      droppedNoTelemetry++;
      continue;
    }
    const samples = semanticSamplesFromReplay(replay);
    const lapGame = meta.gameId ?? opts.gameId;
    laps.push(meta);
    perLapInsights.push(analyzeLap(samples, lapGame, meta.quality));
    perLapStyle.push(summariseLapStyle(samples, lapGame));
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
