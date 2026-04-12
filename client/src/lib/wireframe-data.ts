// ── View types and presets ─────────────────────────────────────────────

export type ViewPreset = "3/4" | "front" | "rear" | "left" | "right" | "top";

export const VIEW_PRESETS: Record<ViewPreset, { position: [number, number, number]; target: [number, number, number] }> = {
  "3/4":  { position: [4, 2.5, 4],    target: [0, 0, 0] },
  front:  { position: [5, 1.5, 0],    target: [0, 0, 0] },
  rear:   { position: [-5, 1.5, 0],   target: [0, 0, 0] },
  left:   { position: [0, 0, -5],     target: [0, 0, 0] },
  right:  { position: [0, 0, 5],      target: [0, 0, 0] },
  top:    { position: [0, 7, 0.01],   target: [0, 0, 0] },
};

// ── View toggles ──────────────────────────────────────────────────────

export interface ViewToggles {
  solid: "wire" | "solid" | "hidden";
  springs: boolean;
  trails: boolean;
  inputs: boolean;
  track: boolean;
  grid: boolean;
  drivetrain: boolean;
  dimensions: boolean;
  wheelInfo: boolean;
}

export const DEFAULT_TOGGLES: ViewToggles = {
  solid: "wire" as const,
  springs: true,
  trails: true,
  inputs: false,
  track: true,
  grid: true,
  drivetrain: true,
  dimensions: false,
  wheelInfo: true,
};
