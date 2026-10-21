export interface CalibrationTransform {
  scale: number;
  rotation: number;
  tx: number;
  tz: number;
}

export interface CalibrationHistoryEntry {
  sequence: number;
  lapNumber: number;
  transform: CalibrationTransform;
  rmse: number | null;
  points: number;
}

/** JSON returned by the calibration comparison endpoint. */
export interface CalibrationComparison {
  calibrated: boolean;
  pointsCollected: number;
  current: CalibrationTransform | null;
  history: CalibrationHistoryEntry[];
}
