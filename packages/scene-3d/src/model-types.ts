export interface CarModelEnrichment {
  importedBody?: boolean;
  bodyFit?: { roll: number; yaw: number; pitch: number; scale: number; x: number; y: number; z: number };
  modelPath: string;
  halfWheelbase: number;
  halfFrontTrack: number;
  halfRearTrack: number;
  bodyLength: number;
  tireRadius: number;
  frontTireWidth?: number;
  rearTireWidth?: number;
  frontTireRadius?: number;
  rearTireRadius?: number;
  /** Full suspension travel range in metres (total stroke, compressed→extended). Optional — falls back to 0.08 default. */
  suspStroke?: number;
  glbWheelbase?: number;
  glbOffsetX?: number;
  glbOffsetY?: number;
  glbOffsetZ?: number;
  solidHiddenMeshes?: number[];
}
