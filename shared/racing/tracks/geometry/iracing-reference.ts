export interface IRacingTrackCalibration {
  source: "recorded-reference";
  referenceLapId: number;
  geometryHash: string;
  origin: { latitude: number; longitude: number; altitude: number };
  alignment: {
    scale: number;
    cos: number;
    sin: number;
    tx: number;
    tz: number;
    flipX: boolean;
    flipZ: boolean;
  };
  /** Fixed reference-run altitude relative to origin, indexed exactly to projection.points. */
  elevationsM: number[] | null;
  /** RMS residual of the reference registration, not absolute edge accuracy. */
  meanErrorM: number;
}
