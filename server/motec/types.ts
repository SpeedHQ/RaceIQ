export interface MotecCarTrack {
  carOrdinal: number;
  trackOrdinal: number;
  /** Display name written into the graphics page for the parser to resolve. */
  carModel: string;
  /** Shared-memory-style track string written into the static page. */
  trackName: string;
}

/** Caller-supplied car/track, which always beats what the log header claims. */
export interface MotecCarTrackOverride {
  carOrdinal?: number;
  trackOrdinal?: number;
}

import type { TelemetryPacket } from "../../shared/telemetry/types";

export interface MotecConversionResult {
  packets: TelemetryPacket[];
  frameCount: number;
  lapCount: number;
  carTrack: MotecCarTrack;
  missingChannels: string[];
  sampleRates: Array<{ name: string; hz: number }>;
  yawFromLateralG: boolean;
}
