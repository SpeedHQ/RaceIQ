export const SPOTTER_PROTOCOL_VERSION = 1 as const;
export const SPOTTER_RENDERING_VERSION = "spotter-v1" as const;

export type SpotterStateV1 =
  | "clear"
  | "car-left"
  | "car-right"
  | "still-there"
  | "three-wide-left"
  | "three-wide-right"
  | "clear-left"
  | "clear-right";

export interface SpotterOpponentPoseV1 {
  id: string;
  x: number;
  z: number;
  speedMps?: number;
}

export interface SpotterFrameV1 {
  sessionId: string;
  timelineEpoch: number;
  sourceSequence: number;
  sessionTimeMs: number;
  player: { x: number; z: number; rotationRad: number; speedMps: number; widthM: number; lengthM: number };
  opponents: readonly SpotterOpponentPoseV1[];
  formationLap?: boolean;
  pitContext?: boolean;
  cautionContext?: boolean;
}

export interface SpotterEventV1 {
  state: Exclude<SpotterStateV1, "clear">;
  side: "left" | "right";
  overlapCount: number;
  sourceSequence: number;
  sessionTimeMs: number;
  opponentIds: readonly string[];
}

export interface SpotterRenderParametersV1 {
  state: SpotterStateV1;
  side?: "left" | "right";
  overlapCount: number;
}

export const SPOTTER_STATES: readonly SpotterStateV1[] = ["clear", "car-left", "car-right", "still-there", "three-wide-left", "three-wide-right", "clear-left", "clear-right"];
export const SPOTTER_EVENT_STATES: readonly Exclude<SpotterStateV1, "clear">[] = SPOTTER_STATES.filter((state): state is Exclude<SpotterStateV1, "clear"> => state !== "clear");

export function isSpotterStateV1(value: unknown): value is SpotterStateV1 { return typeof value === "string" && SPOTTER_STATES.includes(value as SpotterStateV1); }
export function isSpotterFrameV1(value: unknown): value is SpotterFrameV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const player = v.player as Record<string, unknown> | undefined;
  return typeof v.sessionId === "string" && Number.isInteger(v.timelineEpoch) && Number.isInteger(v.sourceSequence) && Number.isFinite(v.sessionTimeMs) && !!player && ["x", "z", "rotationRad", "speedMps", "widthM", "lengthM"].every((key) => typeof player[key] === "number" && Number.isFinite(player[key])) && Array.isArray(v.opponents);
}
export function isSpotterRenderParametersV1(value: unknown): value is SpotterRenderParametersV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isSpotterStateV1(v.state) && (v.side === undefined || v.side === "left" || v.side === "right") && typeof v.overlapCount === "number" && Number.isInteger(v.overlapCount) && v.overlapCount >= 0;
}
