import type { GameId } from "@raceiq/shared/games/ids";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry, SemanticReplayFrame } from "../contracts/replay"
import type { OpponentLapReference, OpponentSemanticLapTelemetry } from "./opponents";

/** Native recording samples. NaN denotes unavailable progress, never an index approximation. */
export interface SpectateSample {
  time: number;
  distance: number;
  run: number;
  values: Readonly<Record<string, unknown>>;
  frame?: SemanticReplayFrame;
}
export interface SpectateLap {
  samples: readonly SpectateSample[];
  /** Distinct F1 motion updates; telemetry samples retain every native channel update. */
  motionSamples?: readonly SpectateSample[];
  duration: number;
  distance: number;
  hasProgress: boolean;
  replay: SemanticLapTelemetry | OpponentSemanticLapTelemetry;
}
export interface SpectatePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}
export interface SpectateReading {
  time: number;
  distance: number | null;
  pose: SpectatePose | null;
  values: Readonly<Record<string, unknown>>;
}
export interface SpectateSnapshot {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
  positionLock: boolean;
  canLock: boolean;
  seeking: boolean;
  generation: number;
  /** Explicit scrub/seek revision; stable during ordinary playback publications. */
  seekGeneration: number;
  a: SpectateReading | null;
  b: SpectateReading | null;
}
/** One animation driver; subscribers must not create replay clocks. */
export interface SpectateController {
  getSnapshot(): SpectateSnapshot;
  getFrameSnapshot(now: number): SpectateSnapshot;
  subscribe(listener: () => void): () => void;
  play(): void;
  pause(): void;
  scrub(time: number): void;
  seekDistance(distance: number, immediate?: boolean): void;
  seekFrame(side: "a" | "b", frameIndex: number): void;
  setSpeed(speed: number): void;
  setPositionLock(locked: boolean): void;
  setActive(active: boolean): void;
  dispose(): void;
  sample(time: number, holdPose?: boolean): { a: SpectateReading | null; b: SpectateReading | null };
}
export interface ReplayOpponentMetadata {
  kind: "opponent";
  id: string;
  reference: Extract<OpponentLapReference, { kind: "opponent" }>;
  trackId: string;
  carId?: string;
  lapNumber: number | null;
  lapTime: number | null;
  sectorTimes?: number[];
  source?: null;
}

export interface ReplaySession {
  gameId: GameId;
  a: SpectateLap;
  b: SpectateLap | null;
  comparison: { lapA: ComparisonData["lapA"]; lapB: ComparisonData["lapB"] | ReplayOpponentMetadata | null; traces?: ComparisonData["traces"]; timeDelta?: ComparisonData["timeDelta"] };
}
/** Compare-only session. */
export interface SpectatePair extends ReplaySession {
  comparison: ComparisonData;
  b: SpectateLap;
}
export interface SpectateSegment {
  name: string;
  type: string;
  startFrac: number;
  endFrac: number;
  number?: number;
  covers?: number[];
  group?: string;
}
