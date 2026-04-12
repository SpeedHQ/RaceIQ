/**
 * Per-car 3D model config.
 * Loaded from server (data/car-model-configs.json).
 * Falls back to default wireframe dimensions when no config exists.
 */
import { client } from "../lib/rpc";

export interface CarModelEnrichment {
  modelPath: string;
  halfWheelbase: number;
  halfFrontTrack: number;
  halfRearTrack: number;
  bodyLength: number;
  tireRadius: number;
  frontTireWidth?: number;   // meters (default 0.30)
  rearTireWidth?: number;    // meters (default 0.30)
  frontTireRadius?: number;  // meters (overrides tireRadius for front)
  rearTireRadius?: number;   // meters (overrides tireRadius for rear)
  /** Full suspension travel range in metres (total stroke, compressed→extended). Optional — falls back to 0.08 default. */
  suspStroke?: number;
  glbWheelbase?: number;
  glbOffsetX?: number;
  glbOffsetY?: number;
  glbOffsetZ?: number;
  glbRotationY?: number;
  solidHiddenMeshes?: number[];
}

export const DEFAULT_CAR: CarModelEnrichment = {
  modelPath: "",
  halfWheelbase: 1.35,
  halfFrontTrack: 0.93,
  halfRearTrack: 0.91,
  bodyLength: 4.5,
  tireRadius: 0.33,
};

/** F1 2025 car model — regulation dimensions (Pirelli 305/720-18 front, 405/720-18 rear) */
export const F1_CAR: CarModelEnrichment & { hasModel: true } = {
  modelPath: "/models/f1_2025_mclaren_mcl39.glb",
  halfWheelbase: 1.80,       // 3600mm wheelbase (regulation max)
  halfFrontTrack: 0.80,      // ~1600mm front track (centre-to-centre)
  halfRearTrack: 0.80,       // ~1600mm rear track (centre-to-centre)
  bodyLength: 5.50,          // ~5500mm overall length
  tireRadius: 0.36,          // 720mm overall diameter → 360mm radius
  frontTireRadius: 0.36,     // 720mm diameter Pirelli
  rearTireRadius: 0.36,      // 720mm diameter Pirelli
  frontTireWidth: 0.305,     // 305mm front tire width
  rearTireWidth: 0.405,      // 405mm rear tire width
  glbOffsetY: -0.12,         // lower model to sit on ground plane
  glbOffsetZ: 0.28,          // nudge model forward to align tires with wireframe wheels
  glbRotationY: Math.PI / 2, // rotate 90° to align with wireframe axes
  hasModel: true,
};

let configs: Record<string, CarModelEnrichment> = {};
let loaded = false;

export async function loadCarModelConfigs(): Promise<void> {
  if (loaded) return;
  try {
    const res = await client.api["car-model-configs"].$get();
    if (res.ok) configs = await res.json();
    loaded = true;
  } catch {}
}

export function getCarModel(carOrdinal: number): CarModelEnrichment & { hasModel: boolean } {
  const config = configs[String(carOrdinal)];
  if (config?.modelPath) return { ...DEFAULT_CAR, ...config, hasModel: true };
  return { ...DEFAULT_CAR, hasModel: false };
}

/** Aston Martin Vantage GT3 — used as demo model in onboarding */
export const DEMO_CAR: CarModelEnrichment & { hasModel: true } = {
  ...DEFAULT_CAR,
  modelPath: "/models/aston_martin_vantage_gt3.glb",
  hasModel: true,
};

/** Get all car ordinals that have 3D models */
export function getCarModelsWithModel(): number[] {
  return Object.entries(configs)
    .filter(([, c]) => c.modelPath)
    .map(([k]) => parseInt(k, 10));
}
