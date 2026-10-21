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
