import type { GameId } from "../types";

/** Configuration that every game must provide. Shared between server and client. */
export interface GameAdapter {
  /** Unique identifier, e.g. "fm-2023", "f1-2025" */
  id: GameId;

  /** Human-readable display name, e.g. "Forza Motorsport 2023" */
  displayName: string;

  /** Short label for tabs/nav, e.g. "Forza", "F1 25" */
  shortName: string;

  /** Route prefix (no leading slash), e.g. "fm23", "f125" */
  routePrefix: string;

  /** Coordinate system used for track maps */
  coordSystem: string;

  /** Steering center value in the raw Steer field (Forza=127, F1/ACC=0) */
  steeringCenter: number;

  /** Steering range: abs(max deviation from center) */
  steeringRange: number;


  /** Resolve car ordinal to human-readable name */
  getCarName(ordinal: number): string;

  /** Resolve track ordinal to human-readable name */
  getTrackName(ordinal: number): string;

  /** Resolve track ordinal to shared outline file name, if available */
  getSharedTrackName?(ordinal: number): string | undefined;

  /** Tire health thresholds — health is 0 (dead) to 1 (fresh) */
  tireHealthThresholds: { green: number; yellow: number };

  /** Tire temp thresholds in °C — blue < cold < green < warm < amber < hot < red */
  tireTempThresholds: { cold: number; warm: number; hot: number };

  /** Car class names (e.g. Forza: D/C/B/A/S/R/P/X) — undefined if N/A */
  carClassNames?: Record<number, string>;

  /** Drivetrain names (e.g. FWD/RWD/AWD) — undefined if N/A */
  drivetrainNames?: Record<number, string>;
}
