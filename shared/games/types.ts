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

  /**
   * Returns the world-space forward offset (dx, dz) for rendering the car arrow
   * at a given yaw angle. Accounts for each game's heading convention.
   * ACC: heading=0 = facing +X (heading = atan2(-z, x))
   * Forza/F1: heading=0 = facing +Z
   */
  carForwardOffset(yaw: number): [number, number];

  /**
   * Returns the canvas rotation angle for follow/car view so the car faces up.
   * Derived from the canvas heading angle for each coordinate system:
   *   Forza/F1: canvas_angle = π/2 + yaw  → rotate by π - yaw
   *   ACC:      canvas_angle = π   + yaw  → rotate by π/2 - yaw
   */
  followViewRotation(yaw: number): number;

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

  /** Optimal tire pressure range in PSI — shown green when in range, blue below, orange above */
  tirePressureOptimal?: { min: number; max: number };

  /** Brake temp thresholds in °C — front/rear have different working ranges */
  brakeTempThresholds?: {
    front: { warm: number; hot: number };
    rear:  { warm: number; hot: number };
  };

  /** Car class names (e.g. Forza: D/C/B/A/S/R/P/X) — undefined if N/A */
  carClassNames?: Record<number, string>;

  /** Drivetrain names (e.g. FWD/RWD/AWD) — undefined if N/A */
  drivetrainNames?: Record<number, string>;
}
