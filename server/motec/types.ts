import type { SourceChannelProfile } from "../../shared/racing/quality/contracts";

export const MOTEC_SYNTH_SOURCE_VERSION = "motec" as const;
export const MOTEC_SYNTH_HZ = 60;

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

export interface SynthesizeResult {
  /** Session `.bin` bytes: 12-byte meta frame, then `[u32 len][frame]` records. */
  bin: Buffer;
  frameCount: number;
  lapCount: number;
  carTrack: MotecCarTrack;
  /** Channels the transcoder looked for and did not find. */
  missingChannels: string[];
  /** True when the path was reconstructed from lateral G because `ROTY` was absent. */
  yawFromLateralG: boolean;
  /** Versioned fidelity overrides for canonical fields occupied by synthesized data. */
  sourceChannelProfile: SourceChannelProfile;
}
