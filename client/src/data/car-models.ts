/**
 * Per-car 3D model config.
 * Loaded from server (data/car-model-configs.json).
 * Falls back to default wireframe dimensions when no config exists.
 */
import { client } from "../lib/rpc";

export interface SpringModelDefinition {
  /** Chassis-side mount height above wheel center, metres. */
  bodyMountHeight: number;
  /** Lateral distance from wheel center toward chassis centerline, metres. */
  inboardOffset: number;
  /** Rendered coil radius, metres. */
  coilRadius: number;
  /** Number of rendered spring coils. */
  coils: number;
  /** Damper rod extension beyond each mount, metres. */
  damperExtension: number;
}

export const DEFAULT_SPRING: SpringModelDefinition = {
  bodyMountHeight: 0.23,
  inboardOffset: 0.35,
  coilRadius: 0.032,
  coils: 6,
  damperExtension: 0.05,
};

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
  /** Full suspension travel range in metres (compressed to extended). */
  suspStroke: number;
  frontSpring: SpringModelDefinition;
  rearSpring: SpringModelDefinition;
  glbWheelbase?: number;
  glbOffsetX?: number;
  glbOffsetY?: number;
  glbOffsetZ?: number;
  glbRotationY?: number;
  solidHiddenMeshes?: number[];
}

export type CarModelConfig = Partial<Omit<CarModelEnrichment, "frontSpring" | "rearSpring">> & {
  frontSpring?: Partial<SpringModelDefinition>;
  rearSpring?: Partial<SpringModelDefinition>;
};

export const DEFAULT_CAR: CarModelEnrichment = {
  modelPath: "",
  halfWheelbase: 1.35,
  halfFrontTrack: 0.93,
  halfRearTrack: 0.91,
  bodyLength: 4.5,
  tireRadius: 0.33,
  frontTireWidth: 0.3,
  rearTireWidth: 0.3,
  frontTireRadius: 0.33,
  rearTireRadius: 0.33,
  suspStroke: 0.08,
  frontSpring: { ...DEFAULT_SPRING },
  rearSpring: { ...DEFAULT_SPRING },
};

/** F1 2025 car model — regulation dimensions (Pirelli 305/720-18 front, 405/720-18 rear) */
export const F1_CAR: CarModelEnrichment & { hasModel: true } = {
  ...DEFAULT_CAR,
  modelPath: "/models/f1_2025_mclaren_mcl39.glb",
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
  glbRotationY: Math.PI / 2, // rotate 90° to align with wireframe axes
  hasModel: true,
};

let configs: Record<string, CarModelConfig> = {};
let loaded = false;

export async function loadCarModelConfigs(): Promise<void> {
  if (loaded) return;
  try {
    const res = await client.api["car-model-configs"].$get();
    if (res.ok) configs = await res.json();
    loaded = true;
  } catch {}
}

export function resolveCarModelDefinition(config: CarModelConfig = {}): CarModelEnrichment {
  return {
    ...DEFAULT_CAR,
    ...config,
    frontSpring: { ...DEFAULT_SPRING, ...config.frontSpring },
    rearSpring: { ...DEFAULT_SPRING, ...config.rearSpring },
  };
}

export function getCarModel(carOrdinal: number): CarModelEnrichment & { hasModel: boolean } {
  const config = configs[String(carOrdinal)];
  if (config?.modelPath) return { ...resolveCarModelDefinition(config), hasModel: true };
  return { ...resolveCarModelDefinition(), hasModel: false };
}

/** Aston Martin Vantage GT3 — used as demo model in onboarding */
export const DEMO_CAR: CarModelEnrichment & { hasModel: true } = {
  ...DEFAULT_CAR,
  modelPath: "/models/aston_martin_vantage_gt3.glb",
  hasModel: true,
};
