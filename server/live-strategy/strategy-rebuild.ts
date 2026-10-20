import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { LapCompleteEvent, LapSavedEvent } from "../lap-detection/types";
import type { CapturedLap } from "../telemetry/pipeline-ports";
import { strategyBoundary, strategyBoundaryReason, strategyContext, strategyContinuousWear } from "./strategy-context";
import { StintMetricAccumulator } from "./stint-accumulator";
import { aggregateLapMetrics, type LapMetricContribution } from "./lap-metrics";
import { getServerGame } from "../games/registry";

interface RebuiltLap { accumulator: StintMetricAccumulator; lapNumber: number; contribution: LapMetricContribution; window: CapturedLap | null }
/** Stages only compact derived evidence. Never admits epochs or appends immutable estimates. */
export class StrategyRebuild {
  readonly accumulators: StintMetricAccumulator[] = [];
  readonly contributions: RebuiltLap[] = [];
  private pending = new Map<number, RebuiltLap[]>();
  private active: StintMetricAccumulator | null = null;
  private previous: TelemetryPacket | null = null;
  private crossedLaps = new Set<number>();
  private observedAt: string;
  private sourceIdentity: Pick<TelemetryPacket, "gameId" | "carId" | "trackId"> | null = null;
  private identityEnded = false;
  private readonly sessionId: number;
  private readonly driverKey: string;
  private readonly fallbackTime: string;
  constructor(sessionId: number, driverKey: string, fallbackTime: string) {
    this.sessionId = sessionId;
    this.driverKey = driverKey;
    this.fallbackTime = fallbackTime;
    this.observedAt = fallbackTime;
  }
  ensure(packet: TelemetryPacket): void {
    if (this.identityEnded) return;
    if (this.sourceIdentity && (packet.gameId !== this.sourceIdentity.gameId ||
        packet.carId !== this.sourceIdentity.carId || packet.trackId !== this.sourceIdentity.trackId)) {
      // A recording can retain the next session's boundary packet as context.
      // That packet ends this source identity; it cannot create reusable evidence here.
      this.active?.close("session-ended", "observed", this.observedAt);
      this.active = null;
      this.previous = null;
      this.identityEnded = true;
      return;
    }
    this.sourceIdentity ??= { gameId: packet.gameId, carId: packet.carId, trackId: packet.trackId };
    if (this.active) return;
    const frameTime = packet.extendedRaceIQ?.frameTimeMs;
    const startedAt = frameTime != null && Number.isFinite(frameTime) ? new Date(frameTime).toISOString() : this.fallbackTime;
    const ordinal = this.accumulators.length + 1;
    this.active = new StintMetricAccumulator({ ...strategyContext(packet), id: `stint-${this.sessionId}-${this.driverKey}-${ordinal}`, sessionId: this.sessionId, driverKey: this.driverKey, ordinal, startedAt });
    this.accumulators.push(this.active);
  }
  observe(packet: TelemetryPacket): void {
    this.ensure(packet);
    if (this.identityEnded) return;
    const boundary = this.previous ? strategyBoundary(this.previous, packet) : 0;
    if (boundary && this.active) {
      if (packet.LapNumber === this.previous?.LapNumber) this.crossedLaps.add(packet.LapNumber);
      this.active.close(strategyBoundaryReason(boundary), "observed", this.observedAt);
      this.active = null;
      this.ensure(packet);
    }
    this.previous = packet;
    const time = packet.extendedRaceIQ?.frameTimeMs;
    if (time != null && Number.isFinite(time)) this.observedAt = new Date(time).toISOString();
  }
  prepare(event: LapCompleteEvent): void {
    if (!this.active || !event.packets.length) return;
    const first = event.packets[0];
    const adapter = getServerGame(first.gameId);
    const contribution = aggregateLapMetrics(event.packets, { valid: event.isValid, lapTimeSeconds: event.lapTime,
      fuelUnit: adapter.telemetry.fuel.packetUnit === "fraction" ? "tankFraction" : "L", allowContinuousWear: strategyContinuousWear(adapter),
      serviceBoundary: this.crossedLaps.delete(first.LapNumber) });
    this.active.add(first.LapNumber, contribution);
    const entry: RebuiltLap = { accumulator: this.active, lapNumber: first.LapNumber, contribution, window: null };
    this.contributions.push(entry);
    const waiting = this.pending.get(first.LapNumber) ?? [];
    waiting.push(entry); this.pending.set(first.LapNumber, waiting);
  }
  saved(event: LapSavedEvent, window: CapturedLap | undefined): void {
    const queue = this.pending.get(event.lapNumber);
    const entry = queue?.shift();
    if (entry && window) entry.window = window;
    if (queue?.length === 0) this.pending.delete(event.lapNumber);
  }
  breakSegment(): void {
    this.active?.close("source-gap", "unknown", this.observedAt, true);
    this.active = null; this.previous = null;
  }
  finish(): void {
    this.active?.close("recording-ended", "unknown", this.observedAt, true);
    this.active = null;
  }
  summaries(): StintSummary[] { return this.accumulators.map((accumulator) => accumulator.snapshot()); }
}
