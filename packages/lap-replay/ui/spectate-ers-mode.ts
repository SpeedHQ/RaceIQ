import type { SpectateReading } from "../contracts/spectate";

export const ERS_DEPLOY_MODES = [
  { value: 0, label: "f1live_ers_mode_none", color: "var(--telemetry-ers-mode-none)" },
  { value: 1, label: "f1live_ers_mode_medium", color: "var(--telemetry-ers-mode-medium)" },
  { value: 2, label: "f1live_ers_mode_hotlap", color: "var(--telemetry-ers-mode-hotlap)" },
  { value: 3, label: "f1live_ers_mode_overtake", color: "var(--telemetry-ers-mode-overtake)" },
] as const;

export function readERSDeployMode(reading: Pick<SpectateReading, "values"> | null): number | null {
  const value = reading?.values["fuel.ers-deploy-mode"];
  if (typeof value === "string" && /^[0-3]$/.test(value)) return Number(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

export interface ERSModeRun { start: number; end: number; mode: number }
/** Merge contiguous recorded modes without extending them through unavailable intervals. */
export function buildERSModeRuns(points: readonly { time: number; a: SpectateReading | null; b: SpectateReading | null }[], side: "a" | "b"): ERSModeRun[] {
  const runs: ERSModeRun[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index]!.time, end = points[index + 1]!.time;
    const mode = readERSDeployMode(points[index]![side]);
    if (mode === null || points[index + 1]![side] === null || end <= start) continue;
    const previous = runs.at(-1);
    if (previous?.mode === mode && previous.end === start) previous.end = end;
    else runs.push({ start, end, mode });
  }
  return runs;
}
