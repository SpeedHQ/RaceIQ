export interface MotecCarTrack {
  carId: string;
  trackId: string;
  /** Display name written into the graphics page for the parser to resolve. */
  carModel: string;
  /** Shared-memory-style track string written into the static page. */
  trackName: string;
}

/** Caller-supplied car/track, which always beats what the log header claims. */
export interface MotecCarTrackOverride {
  carId?: string;
  trackId?: string;
  carName?: string;
  trackName?: string;
  trackConfiguration?: string;
}


import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

export interface MotecConversionResult {
  packets: TelemetryPacket[];
  frameCount: number;
  lapCount: number;
  carTrack: MotecCarTrack;
  missingChannels: string[];
  sampleRates: Array<{ name: string; hz: number }>;
  yawFromLateralG: boolean;
}
