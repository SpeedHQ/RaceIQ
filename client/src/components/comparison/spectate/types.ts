import type { GameId } from "@raceiq/shared/games/ids";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry } from "@/hooks/laps";

/** Native recording samples. NaN denotes unavailable progress, never an index approximation. */
export interface SpectateSample {
  time: number;
  distance: number;
  run: number;
  values: Readonly<Record<string, unknown>>;
}
export interface SpectateLap {
  samples: readonly SpectateSample[];
  /** Distinct F1 motion updates; telemetry samples retain every native channel update. */
  motionSamples?: readonly SpectateSample[];
  duration: number;
  distance: number;
  hasProgress: boolean;
  replay: SemanticLapTelemetry;
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
  setSpeed(speed: number): void;
  setPositionLock(locked: boolean): void;
  setActive(active: boolean): void;
  dispose(): void;
  sample(time: number, holdPose?: boolean): { a: SpectateReading | null; b: SpectateReading | null };
}
export interface SpectatePair {
  gameId: GameId;
  comparison: ComparisonData;
  a: SpectateLap;
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
