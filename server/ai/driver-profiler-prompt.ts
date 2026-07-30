import type { DriverFingerprint, DriverTrend, DriverTrendWindow } from "./driver-profile-aggregate";

export interface DriverProfilerPromptContext {
  fingerprint: DriverFingerprint;
  /** Settings language, e.g. "en". Passed through to the output-language line. */
  language?: string;
}

function percentage(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "not measured" : `${value.toFixed(1)}%`;
}

function score(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "not measured" : `${value.toFixed(0)}/100`;
}

function trendWindow(label: string, window: DriverTrendWindow): string {
  return [
    `${label}: ${window.total} laps (${window.valid} clean, ${window.dirty} dirty)`,
    `clean rate ${percentage(window.cleanRate === null ? null : window.cleanRate * 100)}`,
    `consistency ${score(window.consistency)}`,
    `median relative pace ${percentage(window.medianPacePct)}`,
    `spread ${percentage(window.spreadPct)}`,
  ].join("; ");
}

function trendDirections(trend: DriverTrend): string {
  return [
    `pace ${trend.paceDirection}`,
    `consistency ${trend.consistencyDirection}`,
    `validity ${trend.validityDirection}`,
  ].join(", ");
}

export function buildDriverProfilerPrompt(ctx: DriverProfilerPromptContext): string {
  const trend = ctx.fingerprint.trend;
  const advice = trend.advice.length
    ? trend.advice.map((item) => `- ${item.title}: ${item.detail}`).join("\n")
    : "- No deterministic advice available.";

  const parts = [
    "# GLOBAL DRIVER TREND",
    "This handoff describes only the selected game's global trend. Use these deterministic measurements as the complete evidence base.",
    trendWindow("Recent window", trend.recent),
    trendWindow("Previous window", trend.previous),
    `Directions: ${trendDirections(trend)}.`,
    `Deterministic trend advice (context only):\n${advice}`,
    "",
    "## YOUR TASK",
    "Return a strict JSON object with exactly headline and summary.",
    "headline: one clear trend headline, 1-80 characters.",
    "summary: 2-3 sentences explaining why the trend is credible using only the supplied counts, consistency, normalized relative pace, spread, clean rate, directions, and deterministic advice.",
    "Do not make recommendations or prescribe actions. Do not mention specific laps, corners, cars, tracks, reference points, drills, examples, fault identifiers, axis scores, raw lap times, or future-session steps.",
    "Output JSON only, with no markdown fences or prose outside the object.",
  ];

  if (ctx.language && ctx.language !== "en") {
    parts.push(`Write all prose in language code "${ctx.language}".`);
  }

  return parts.join("\n");
}
