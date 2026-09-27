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
  frontTireWidth?: number; // meters (default 0.30)
  rearTireWidth?: number; // meters (default 0.30)
  frontTireRadius?: number; // meters (overrides tireRadius for front)
  rearTireRadius?: number; // meters (overrides tireRadius for rear)
  /** Full suspension travel range in metres (total stroke, compressed→extended). Optional — falls back to 0.08 default. */
  suspStroke?: number;
  glbWheelbase?: number;
  glbOffsetX?: number;
  glbOffsetY?: number;
  glbOffsetZ?: number;
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
  modelPath: "/models/f1_2025_mclaren_mcl39_optimised.glb",
  halfWheelbase: 1.8, // 3600mm wheelbase (regulation max)
  halfFrontTrack: 0.8, // ~1600mm front track (centre-to-centre)
  halfRearTrack: 0.8, // ~1600mm rear track (centre-to-centre)
  bodyLength: 5.5, // ~5500mm overall length
  tireRadius: 0.36, // 720mm overall diameter → 360mm radius
  frontTireRadius: 0.36, // 720mm diameter Pirelli
  rearTireRadius: 0.36, // 720mm diameter Pirelli
  frontTireWidth: 0.305, // 305mm front tire width
  rearTireWidth: 0.405, // 405mm rear tire width
  glbOffsetY: -0.12, // lower model to sit on ground plane
  glbOffsetZ: 0.28, // nudge model forward to align tires with wireframe wheels
  hasModel: true,
};

/** Peugeot 9X8 Evo — representative LMU hypercar model. */
export const LMU_HYPERCAR_CAR: CarModelEnrichment & { hasModel: true } = {
  ...DEFAULT_CAR,
  modelPath: "/models/peugeot_9x8_evo_2024_optimised.glb",
  halfWheelbase: 1.52, // ~3040mm wheelbase
  halfFrontTrack: 0.85, // ~1700mm front track
  halfRearTrack: 0.85, // ~1700mm rear track
  bodyLength: 5.0, // ~5000mm overall length
  tireRadius: 0.36, // ~720mm overall diameter
  frontTireRadius: 0.36,
  rearTireRadius: 0.36,
  frontTireWidth: 0.31,
  rearTireWidth: 0.31,
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
  modelPath: "/models/aston_martin_vantage_gt3_optimised.glb",
  hasModel: true,
};

/** Closest available LMU body for each catalog class. */
export const LMU_CLASS_CAR_MODELS: Record<string, CarModelEnrichment & { hasModel: true }> = {
  GT3: DEMO_CAR,
  GTE: DEMO_CAR,
  PACECAR: DEMO_CAR,
  HYPERCAR: LMU_HYPERCAR_CAR,
  LMP2: LMU_HYPERCAR_CAR,
  LMP3: LMU_HYPERCAR_CAR,
};

export function getLMUClassCarModel(carClass?: string): CarModelEnrichment & { hasModel: true } {
  return LMU_CLASS_CAR_MODELS[carClass?.toUpperCase() ?? ""] ?? LMU_HYPERCAR_CAR;
}
