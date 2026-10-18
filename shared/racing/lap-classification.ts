export const LAP_CLASSIFICATIONS = [
  "pace",
  "out_lap",
  "in_lap",
  "pit_lap",
  "grid_start",
  "caution",
  "reset",
] as const;

export type LapClassification = (typeof LAP_CLASSIFICATIONS)[number];

/** Legacy null categories remain pace-eligible until evidence is available. */
export function isPaceLap(classification: LapClassification | null | undefined): boolean {
  return classification == null || classification === "pace";
}
