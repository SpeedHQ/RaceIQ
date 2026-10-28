import type { Row, Transaction } from "@libsql/client";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { StrategyHistoryUpdatedMessage } from "@raceiq/shared/racing/live/strategy";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import type { LapCompleteEvent, LapSavedEvent, SessionState } from "../lap-detection/types";
import type { ServerGameRuntimePolicy } from "../games/types";
import type { CapturedLap } from "./pipeline-ports";

export interface PitTrackerPort {
  reset(): void;
  setTireWearAvailable(available: boolean): void;
  seedFromHistory(trackId: string, carId: string, pi: number, gameId: GameId, policy: ServerGameRuntimePolicy["pit"]): Promise<void>;
  updateWearCurves(packets: TelemetryPacket[], lapDistStart: number): void;
  feed(packet: TelemetryPacket, trackLength: number, lapDistStart?: number, thresholds?: [TireThresholds, TireThresholds, TireThresholds, TireThresholds]): LivePitData;
  getDebugState(): Record<string, unknown>;
}

export interface DurableStrategyPort {
  start(session: SessionState, packet: TelemetryPacket, captureEpoch: string): Promise<void>;
  beginFrame(packet: TelemetryPacket): void;
  observe(packet: TelemetryPacket): void;
  prepareLap(event: LapCompleteEvent): void;
  savedLap(event: LapSavedEvent): void;
  lapWriteFailed(sessionId: number, lapNumber: number, error: Error): void;
  bindCaptureEpoch(epoch: string): void;
  admitClearBoundary(sessionId: number, driverKey: string): Promise<void>;
  finish(): Promise<void>;
  flush(): Promise<void>;
  discardSession(sessionId: number): void;
  consumeTireReset(): boolean;
  apply(packet: TelemetryPacket, pit: LivePitData): LivePitData;
  dispose(): void;
}

export interface StrategyRebuildPort {
  ensure(packet: TelemetryPacket): void;
  observe(packet: TelemetryPacket): void;
  prepare(event: LapCompleteEvent): void;
  saved(event: LapSavedEvent, window: CapturedLap | undefined): void;
  breakSegment(): void;
  finish(): void;
  activate(transaction: Transaction, expected: { gameId: GameId; carId: string; trackId: string; ownership: string }, laps: readonly Row[]): Promise<StrategyHistoryUpdatedMessage[]>;
}

export interface RaceStrategyRuntime {
  createPitTracker(): PitTrackerPort;
  createLiveTracker(notify: (message: Record<string, unknown>) => void): DurableStrategyPort;
  createRebuild(sessionId: number, driverKey: string, fallbackTime: string): StrategyRebuildPort;
  needsBackfill(sessionId: number): Promise<boolean>;
  clearEstimates(sessionId: number, driverKey?: string): Promise<number>;
  publishHistory(changes: readonly StrategyHistoryUpdatedMessage[]): void;
}

let runtime: RaceStrategyRuntime | undefined;
export function registerRaceStrategyRuntime(value: RaceStrategyRuntime): void { runtime = value; }
export function raceStrategyRuntime(): RaceStrategyRuntime {
  if (!runtime) throw new Error("Race strategy runtime has not been registered by the application");
  return runtime;
}
