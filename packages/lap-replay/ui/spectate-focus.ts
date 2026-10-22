import { resolveBalance } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { getGame } from "@raceiq/shared/games/registry";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { controlInputPercent } from "@raceiq/scene-3d/vehicle-dynamics";
import type { ReplaySession, SpectateSample } from "../contracts/spectate";

export type SpectateFocusMode = "inputs" | "ers" | "balance" | "speed";
export interface FocusLegendEntry { label: string; token: string }
export interface SpectateFocus {
  mode: SpectateFocusMode;
  legend: readonly FocusLegendEntry[];
  color: (sample: SpectateSample) => string;
}
export const FOCUS_MODES: readonly { mode: SpectateFocusMode; label: string }[] = [
  { mode: "inputs", label: "Inputs" },
  { mode: "ers", label: "ERS mode" },
  { mode: "balance", label: "Balance" },
  { mode: "speed", label: "Speed" },
];
const unavailable = { label: "Unavailable", token: "--app-text-muted" };
const inputLegend = [
  { label: "Brake", token: "--ch-brake" },
  { label: "Throttle", token: "--ch-throttle" },
  { label: "Coast / unavailable", token: unavailable.token },
];
export function inputFocusColor(sample: SpectateSample): string {
  const brake = numeric(sample, "inputs.brake"), throttle = numeric(sample, "inputs.accel");
  return brake !== null && controlInputPercent(brake) > 0 ? "--ch-brake"
    : throttle !== null && controlInputPercent(throttle) > 0 ? "--ch-throttle" : unavailable.token;
}
function numeric(sample: SpectateSample, id: string): number | null {
  const value = sample.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One classifier and scale for both lap traces and both renderers. */
export function buildSpectateFocus(pair: ReplaySession, mode: SpectateFocusMode): SpectateFocus {
  if (mode === "inputs") return { mode, legend: inputLegend, color: inputFocusColor };
  if (mode === "ers") {
    const legend = [
      { label: "None", token: "--telemetry-ers-mode-none" },
      { label: "Medium", token: "--telemetry-ers-mode-medium" },
      { label: "Hotlap", token: "--telemetry-ers-mode-hotlap" },
      { label: "Overtake", token: "--telemetry-ers-mode-overtake" },
    ];
    return { mode, legend: [...legend, unavailable], color: (sample) => {
      const raw = sample.values["fuel.ers-deploy-mode"];
      const value = typeof raw === "string" && /^[0-3]$/.test(raw) ? Number(raw) : raw;
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? legend[value].token : unavailable.token;
    } };
  }
  if (mode === "balance") {
    const metric = resolveAnalysisTelemetry(getGame(pair.gameId)).balance;
    const legend = [
      { label: "Understeer", token: "--balance-positive" },
      { label: "Neutral", token: "--balance-neutral" },
      { label: "Oversteer", token: "--balance-negative" },
    ];
    return { mode, legend: [...legend, unavailable], color: (sample) => {
      const balance = resolveBalance(sample, metric);
      return balance === null ? unavailable.token : balance.state === "understeer" ? legend[0].token : balance.state === "neutral" ? legend[1].token : legend[2].token;
    } };
  }
  let maximum = 0;
  for (const lap of [pair.a, ...(pair.b ? [pair.b] : [])]) for (const sample of lap.samples) {
    const speed = numeric(sample, "motion.speed");
    if (speed !== null) maximum = Math.max(maximum, speed);
  }
  const legend = [
    { label: "Low · 0–⅓ max", token: "--telemetry-ers-mode-medium" },
    { label: "Mid · ⅓–⅔ max", token: "--telemetry-ers-mode-hotlap" },
    { label: "High · ⅔–max", token: "--telemetry-ers-mode-overtake" },
  ];
  return { mode, legend: [...legend, unavailable], color: (sample) => {
    const speed = numeric(sample, "motion.speed");
    if (speed === null || speed < 0) return unavailable.token;
    return legend[maximum === 0 || speed < maximum / 3 ? 0 : speed < maximum * 2 / 3 ? 1 : 2].token;
  } };
}

/** Preserve native run boundaries, missing positions, and telemetry gaps. */
export function focusRuns(samples: readonly SpectateSample[], focus: SpectateFocus) {
  const runs: { token: string; points: { x: number; z: number }[] }[] = [];
  let previous: SpectateSample | null = null;
  let run: (typeof runs)[number] | null = null;
  for (const sample of samples) {
    const x = numeric(sample, "motion.position-x"), z = numeric(sample, "motion.position-z");
    if (x === null || z === null) { previous = null; run = null; continue; }
    const connected = previous && previous.run === sample.run && sample.time >= previous.time && sample.time - previous.time <= 0.1;
    if (previous && connected) {
      const token = focus.color(sample);
      if (!run || run.token !== token) {
        run = { token, points: [{ x: previous.values["motion.position-x"] as number, z: previous.values["motion.position-z"] as number }] };
        runs.push(run);
      }
      run.points.push({ x, z });
    } else run = null;
    previous = sample;
  }
  return runs;
}
