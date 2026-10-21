import type {
  ResolvedValue,
  TelemetryTimestamp,
} from "./resolver/contracts";

export interface LmuSupplementalObservation {
  readonly semanticId: string;
  readonly endpoint: string;
  readonly method: "GET";
  readonly sessionKey: string;
  readonly vehicleId: number | null;
  readonly applicability: "player-vehicle" | "session";
  /** Acquisition timestamp; distinct from `observation.provenance.observedAt`. */
  readonly acquiredAt: TelemetryTimestamp;
  readonly responseVersion: string | null;
  readonly observation: ResolvedValue<unknown>;
}
