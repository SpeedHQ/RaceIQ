/**
 * Per-car 3D model config.
 * Loaded from server (data/car-model-configs.json).
 * Falls back to default wireframe dimensions when no config exists.
 */

export interface CarModelEnrichment {
  modelPath: string;
  halfWheelbase: number;
  halfFrontTrack: number;
  halfRearTrack: number;
  bodyLength: number;
  tireRadius: number;
  glbWheelbase?: number;
  glbOffsetX?: number;
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

let configs: Record<string, CarModelEnrichment> = {};
let loaded = false;

export async function loadCarModelConfigs(): Promise<void> {
  if (loaded) return;
  try {
    const res = await fetch("/api/car-model-configs");
    if (res.ok) configs = await res.json();
    loaded = true;
  } catch {}
}

export function getCarModel(carOrdinal: number): CarModelEnrichment & { hasModel: boolean } {
  const config = configs[String(carOrdinal)];
  if (config?.modelPath) return { ...DEFAULT_CAR, ...config, hasModel: true };
  return { ...DEFAULT_CAR, hasModel: false };
}

/** Get all car ordinals that have 3D models */
export function getCarModelsWithModel(): number[] {
  return Object.entries(configs)
    .filter(([, c]) => c.modelPath)
    .map(([k]) => parseInt(k, 10));
}
