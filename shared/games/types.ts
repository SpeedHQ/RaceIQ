import type { GameId } from "./ids";
import type { TelemetryPacket } from "../telemetry/types";

export type AnalysisTelemetryMetric =
  | {
      source: "direct";
      freshness: "continuous" | "pit-snapshot" | "static";
      display?: "per-wheel" | "vehicle" | "normalized" | "millimeters" | "cold-pressure";
    }
  | {
      source: "derived";
      confidence: "exact" | "high";
      display?: "per-wheel" | "compression-bias";
    }
  | {
      source: "unavailable";
      reason: "source-limitation" | "missing-model";
    };

export interface AnalysisTelemetryModel {
  balance: AnalysisTelemetryMetric;
  gForce: AnalysisTelemetryMetric;
  gripDemand: AnalysisTelemetryMetric;
  traction: AnalysisTelemetryMetric;
  tireTemperature: AnalysisTelemetryMetric;
  surface: AnalysisTelemetryMetric;
  slipRatio: AnalysisTelemetryMetric;
  slipAngle: AnalysisTelemetryMetric;
  wheelRotation: AnalysisTelemetryMetric;
  tireHealth: AnalysisTelemetryMetric;
  tireWearRate: AnalysisTelemetryMetric;
  tirePressure: AnalysisTelemetryMetric;
  suspensionTravel: AnalysisTelemetryMetric;
  suspensionCompressionBias: AnalysisTelemetryMetric;
}

export type PacketUnit =
  | "fraction"
  | "litre"
  | "celsius"
  | "fahrenheit"
  | "psi"
  | "watt"
  | "newton-metre";

export interface ScalarTelemetrySpec<
  Unit extends PacketUnit = PacketUnit,
> {
  packetUnit: Unit;
}
/** Presence declares a channel whose values originate in the game source. */
export interface TelemetryChannelSpec {
  source: "direct";
  freshness: "continuous" | "pit-snapshot" | "static";
}


export interface TelemetryModel {
  fuel: ScalarTelemetrySpec<"fraction" | "litre">;
  tireTemperature: ScalarTelemetrySpec<"celsius" | "fahrenheit">;
  boost?: ScalarTelemetrySpec<"psi">;
  power?: ScalarTelemetrySpec<"watt">;
  torque?: ScalarTelemetrySpec<"newton-metre">;
  brakeTemperature?: ScalarTelemetrySpec<"celsius" | "fahrenheit">;
  tirePressure?: ScalarTelemetrySpec<"psi">;
  ers?: true;
  clutch?: TelemetryChannelSpec;
  handBrake?: TelemetryChannelSpec;
  weather?: TelemetryChannelSpec;
  pitStatus?: TelemetryChannelSpec;

  /**
   * Analysis-panel semantics. Omitted fields inherit the current cross-game
   * defaults; adapters override only genuine source or model differences.
   */
  analysis?: Partial<AnalysisTelemetryModel>;
}

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

  /** Semantic telemetry capabilities and freshness owned by this game. */
  telemetry: TelemetryModel;

  /** Coordinate system used for track maps */
  coordSystem: string;

  /** Sector boundaries and lap fraction are supplied authoritatively by telemetry. */
  nativeSectors: boolean;

  /** Read the source-defined sector layout from a normalized telemetry frame. */
  getNativeSectorLayout?(packet: TelemetryPacket): {
    starts: number[];
    lapFraction?: number;
    trackLengthM?: number;
  } | undefined;

  /** Raw-lap replay should synthesize a finish sample from the following frame. */
  appendsDelayedFinishFrame: boolean;

  /** Telemetry track length must not be refined from observed completed distance. */
  authoritativeTrackLength: boolean;

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

  /** Resolve a game-native track name (e.g. saved on a session/lap) back to its ordinal, if available */
  getTrackOrdinalByName?(name: string): number | undefined;

  /** Tire health thresholds — health is 0 (dead) to 1 (fresh) */
  tireHealthThresholds: { green: number; yellow: number };

  /** Tire temp thresholds in °C — blue < cold < green < warm < amber < hot < red */
  tireTempThresholds: { cold: number; warm: number; hot: number };

  /** Suspension travel color thresholds — normalised 0–100 percent.
   *  Bar colours step red → amber → green → blue as travel rises through
   *  these values. Same shape for all games; per-car overrides can layer
   *  on top later if needed. */
  suspensionThresholds: { values: number[] };

  /** Optimal tire pressure range in PSI — shown green when in range, blue
   *  below, orange above. Games that need class-aware windows (e.g. ACC's
   *  GT3/GT4/TCX split) resolve this server-side via a game-specific API. */
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

