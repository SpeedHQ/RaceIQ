import { repeatabilityStats } from "../../shared/laps/stint-stats";
import type { LapMeta } from "../../shared/sessions/types";
import { median, round4 } from "./math";

export const DRIVER_TREND_WINDOW_LAPS = 30;

export type TrendDirection = "improving" | "steady" | "declining" | "unavailable";

export interface DriverTrendLap {
  id: number;
  createdAt: string;
  isValid: boolean;
  relativePacePct: number | null;
}

export interface DriverTrendWindow {
  laps: DriverTrendLap[];
  total: number;
  valid: number;
  dirty: number;
  cleanRate: number | null;
  normalized: number;
  consistency: number | null;
  medianPacePct: number | null;
  spreadPct: number | null;
  contexts: number;
}

export interface DriverTrendAdvice {
  id: "build-baseline" | "keep-approach" | "stabilize-pace" | "add-pace" | "reset-baseline" | "hold-steady" | "protect-validity";
  tone: "positive" | "neutral" | "caution";
  title: string;
  detail: string;
}

export interface DriverTrend {
  recent: DriverTrendWindow;
  previous: DriverTrendWindow;
  consistencyDelta: number | null;
  paceDeltaPct: number | null;
  spreadDeltaPct: number | null;
  cleanRateDelta: number | null;
  consistencyDirection: TrendDirection;
  paceDirection: TrendDirection;
  validityDirection: TrendDirection;
  advice: DriverTrendAdvice[];
}

function trendContextKey(lap: LapMeta): string {
  return `${lap.gameId ?? "?"}|${lap.carOrdinal ?? "?"}|${lap.trackOrdinal ?? "?"}`;
}

function direction(delta: number | null, improveAt: number, declineAt: number): TrendDirection {
  if (delta === null) return "unavailable";
  if (delta >= improveAt) return "improving";
  if (delta <= declineAt) return "declining";
  return "steady";
}

function trendWindow(laps: readonly LapMeta[], benchmarks: ReadonlyMap<string, number>): DriverTrendWindow {
  let valid = 0;
  const comparableContexts = new Set<string>();
  const chartLaps = laps.map((lap) => {
    if (lap.isValid) valid++;
    const context = trendContextKey(lap);
    const benchmark = benchmarks.get(context);
    if (benchmark !== undefined) comparableContexts.add(context);
    const relativePacePct =
      benchmark !== undefined && Number.isFinite(lap.lapTime) && lap.lapTime > 0
        ? Math.max(0, (lap.lapTime / benchmark - 1) * 100)
        : null;
    return { id: lap.id, createdAt: lap.createdAt, isValid: lap.isValid, relativePacePct };
  }).reverse();
  const paceValues = chartLaps.flatMap((lap) => (lap.relativePacePct === null ? [] : [lap.relativePacePct]));
  const repeatability = repeatabilityStats(paceValues.map((pace) => 1 + pace / 100));
  return {
    laps: chartLaps,
    total: laps.length,
    valid,
    dirty: laps.length - valid,
    cleanRate: laps.length === 0 ? null : valid / laps.length,
    normalized: repeatability.n,
    consistency: repeatability.consistency === null ? null : round4(repeatability.consistency),
    medianPacePct: median(paceValues.map((pace) => round4(pace))),
    spreadPct: repeatability.sd === null ? null : round4(repeatability.sd * 100),
    contexts: comparableContexts.size,
  };
}

function adviceFor(
  recent: DriverTrendWindow,
  previous: DriverTrendWindow,
  paceDirection: TrendDirection,
  consistencyDirection: TrendDirection,
): DriverTrendAdvice[] {
  const missingMetric =
    recent.normalized < 2 ||
    previous.normalized < 2 ||
    recent.consistency === null ||
    previous.consistency === null ||
    recent.medianPacePct === null ||
    previous.medianPacePct === null;
  let primary: DriverTrendAdvice;
  if (missingMetric) {
    primary = { id: "build-baseline", tone: "neutral", title: "Keep building the baseline", detail: "A trend needs both recent and previous windows to contain comparable pace data." };
  } else if (paceDirection === "improving" && consistencyDirection === "improving") {
    primary = { id: "keep-approach", tone: "positive", title: "Your improvement looks repeatable", detail: "Pace and consistency moved together. Keep the approach stable instead of chasing a larger change." };
  } else if (paceDirection === "improving" && consistencyDirection === "declining") {
    primary = { id: "stabilize-pace", tone: "caution", title: "Consolidate the new speed", detail: "Pace improved while repeatability fell. Hold the current pace until consistency returns." };
  } else if (consistencyDirection === "improving" && (paceDirection === "steady" || paceDirection === "declining")) {
    primary = { id: "add-pace", tone: "positive", title: "Use the stable base to add pace", detail: "Your laps are becoming more repeatable. Preserve that rhythm and add speed gradually." };
  } else if (consistencyDirection === "declining" && paceDirection !== "improving") {
    primary = { id: "reset-baseline", tone: "caution", title: "Reset to a repeatable baseline", detail: "Pace and repeatability are not moving together. Reduce variation before pushing again." };
  } else {
    primary = { id: "hold-steady", tone: "neutral", title: "Performance is stable", detail: "Neither pace nor consistency moved enough to call a trend. Change one thing at a time and keep building evidence." };
  }
  const advice = [primary];
  if (recent.cleanRate !== null && previous.cleanRate !== null && recent.cleanRate - previous.cleanRate <= -0.05) {
    advice.push({ id: "protect-validity", tone: "caution", title: "Protect validity before pushing harder", detail: "Dirty-lap rate worsened. Keep the current pace inside the valid-lap envelope before adding more risk." });
  }
  return advice;
}

export function buildDriverTrend(candidatesNewestFirst: readonly LapMeta[]): DriverTrend {
  const benchmarks = new Map<string, number>();
  for (const lap of candidatesNewestFirst) {
    if (!lap.isValid || !Number.isFinite(lap.lapTime) || lap.lapTime <= 0) continue;
    const key = trendContextKey(lap);
    const current = benchmarks.get(key);
    if (current === undefined || lap.lapTime < current) benchmarks.set(key, lap.lapTime);
  }
  const recent = trendWindow(candidatesNewestFirst.slice(0, DRIVER_TREND_WINDOW_LAPS), benchmarks);
  const previous = trendWindow(candidatesNewestFirst.slice(DRIVER_TREND_WINDOW_LAPS, DRIVER_TREND_WINDOW_LAPS * 2), benchmarks);
  const consistencyDelta = recent.consistency !== null && previous.consistency !== null ? round4(recent.consistency - previous.consistency) : null;
  const paceDeltaPct = recent.medianPacePct !== null && previous.medianPacePct !== null ? round4(recent.medianPacePct - previous.medianPacePct) : null;
  const spreadDeltaPct = recent.spreadPct !== null && previous.spreadPct !== null ? round4(recent.spreadPct - previous.spreadPct) : null;
  const cleanRateDelta = recent.cleanRate !== null && previous.cleanRate !== null ? round4(recent.cleanRate - previous.cleanRate) : null;
  const consistencyDirection = direction(consistencyDelta, 2, -2);
  const paceDirection: TrendDirection = paceDeltaPct === null ? "unavailable" : paceDeltaPct <= -0.25 ? "improving" : paceDeltaPct >= 0.25 ? "declining" : "steady";
  const validityDirection = direction(cleanRateDelta, 0.05, -0.05);
  return {
    recent,
    previous,
    consistencyDelta,
    paceDeltaPct,
    spreadDeltaPct,
    cleanRateDelta,
    consistencyDirection,
    paceDirection,
    validityDirection,
    advice: adviceFor(recent, previous, paceDirection, consistencyDirection),
  };
}
