import type { SemanticAnalysisFrame } from "./track-map/types";

const ERS_CHANNELS = ["fuel.ers-store-energy", "fuel.ers-deployed", "fuel.ers-harvested", "fuel.ers-deploy-mode"] as const;

const hasDrsValue = (value: unknown): boolean => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const hasErsValue = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

export interface LapCapabilities {
  hasDrs: boolean;
  hasErs: boolean;
}

export function detectLapCapabilities(frames: readonly SemanticAnalysisFrame[]): LapCapabilities {
  let hasDrs = false;
  let hasErs = false;
  for (const frame of frames) {
    if (!hasDrs && hasDrsValue(frame.values["aero.drs-active"])) hasDrs = true;
    if (!hasErs && ERS_CHANNELS.some((channel) => hasErsValue(frame.values[channel]))) hasErs = true;
    if (hasDrs && hasErs) break;
  }
  return { hasDrs, hasErs };
}
