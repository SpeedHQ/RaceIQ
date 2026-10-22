import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { HistoricalBaseline, LiveStrategy, MetricRate, PitEstimateRecord, SourceOrder, StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { LapCompleteEvent, LapSavedEvent, SessionState } from "@raceiq/backend-core/lap-detection/types";
import { client } from "@raceiq/backend-core/db/index";
import { admitStrategyObservation, closeStrategyStint, persistStrategyLapMetrics, savePitEstimate, saveStrategyStint, StaleStrategyIdentityError } from "./strategy-queries";
import { getStrategyBaseline } from "./strategy-baseline-queries";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { aggregateLapMetrics, STRATEGY_ALGORITHM_VERSION } from "./lap-metrics";
import { StintMetricAccumulator } from "./stint-accumulator";
import { strategyContext, strategyBoundaryReason, strategyContinuousWear, StrategyBoundary, StrategyBoundaryTracker } from "./strategy-context";
import { getPacketTireCompound, getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { getTireThresholdOverrides } from "@raceiq/backend-core/runtime/config/settings";
import { subscribeStrategyHistory } from "./history-events";
import { supportsRaceRefueling } from "../contracts/race-rules";

interface StintState {
  accumulator: StintMetricAccumulator; baseline: HistoricalBaseline | null; live: LiveStrategy;
  generation: number; expectedHistoryRevision: number; refreshing: boolean;
  sourceEpoch: string; lastPacket: TelemetryPacket; lastObservedAt: number; cancelled: boolean;
}
interface PendingLap { state: StintState; resolve: (event: LapSavedEvent) => void; reject: (error: Error) => void }
interface WriteJob { state: StintState; run: () => Promise<void> }
interface Admission { sessionId: number; sourceEpoch: string; coordinate: number; order?: SourceOrder; running: boolean; cancelled: boolean; waiters: Array<{ resolve: (order: SourceOrder) => void; reject: (error: Error) => void }> }
const sourceCoordinate = Symbol("strategy-source-coordinate");
let nextSourceCoordinate = 0;
class TerminalLapSaveError extends Error {}
const wheels = ["TireWearFL", "TireWearFR", "TireWearRL", "TireWearRR"] as const;

/** Ordered small evidence writes; no database work or raw-history decoding at frame rate. */
 
export class DurableStrategyTracker {
  private active: StintState | null = null;
  private admissions = new Map<string, Admission>();
  private admissionQueue: Admission[] = [];
  private session: SessionState | null = null;
  private previous: TelemetryPacket | null = null;
  private driverKey = "local-player";
  private ordinal = 0;
  private epoch = 0;
  private captureEpoch = "";
  private readonly boundaryTracker = new StrategyBoundaryTracker();
  private crossedLaps = new Set<number>();
  private pending = new Map<string, PendingLap[]>();
  private processedLaps = new Set<number>();
  private jobs: WriteJob[] = [];
  private draining: Promise<void> | null = null;
  private drainRequested = false;
  private persistenceError = false;
  private lastLimiter: LivePitData["limitedBy"] = null;
  private tireReset = false;
  private readonly unsubscribe: () => void;
  private readonly notify: (message: Record<string, unknown>) => void;
  constructor(notify: (message: Record<string, unknown>) => void) {
    this.notify = notify;
    this.unsubscribe = subscribeStrategyHistory((event) => {
      const state = this.active;
      if (!state || state.live.driverKey !== event.driverKey || this.session?.gameId !== event.gameId) return;
      if (event.historyRevision <= state.expectedHistoryRevision) return;
      state.expectedHistoryRevision = event.historyRevision;
      state.baseline = null;
      this.updateLive(state, true);
      void this.refreshBaseline(state);
    });
  }
  async start(session: SessionState, packet: TelemetryPacket, captureEpoch: string): Promise<void> {
    if (this.session?.sessionId === session.sessionId && this.active) return;
    await this.finish();
    this.session = session; this.previous = null; this.ordinal = 0;
    this.captureEpoch = captureEpoch; this.epoch = 0; this.boundaryTracker.reset();
    this.crossedLaps.clear(); this.lastLimiter = null;
    try {
      const ownership = await client.execute({ sql: "SELECT ownership FROM sessions WHERE id=?", args: [session.sessionId] });
      this.driverKey = ownership.rows[0]?.ownership === "mine" ? "local-player" : `unidentified-source:${session.sessionId}`;
    } catch (error) {
      this.driverKey = `unidentified-source:${session.sessionId}`;
      this.persistenceError = true;
      console.error("[Strategy] Driver ownership unavailable:", error);
    }
    this.createStint(packet);
    await this.drain();
  }
  private createStint(packet: TelemetryPacket): void {
    if (!this.session) return;
    const context = strategyContext(packet);
    const ordinal = ++this.ordinal;
    const accumulator = new StintMetricAccumulator({ ...context, id: `stint-${this.session.sessionId}-${this.driverKey}-${ordinal}`, sessionId: this.session.sessionId, driverKey: this.driverKey, ordinal, startedAt: new Date().toISOString() });
    const summary = accumulator.snapshot();
    const state: StintState = { accumulator, baseline: null, generation: 0, expectedHistoryRevision: 0, refreshing: false, cancelled: false,
      sourceEpoch: `${this.captureEpoch}:${this.epoch}`, lastPacket: packet, lastObservedAt: Date.now(),
      live: { sessionId: summary.sessionId, driverKey: summary.driverKey, stintId: summary.id, revision: summary.revision, historyRevision: 0, fuel: summary.fuel, tires: summary.tires, baseline: null, persistence: this.persistenceError ? "error" : "ok" } };
    this.active = state;
    this.enqueue(state, async () => {
      await saveStrategyStint(accumulator.snapshot(), accumulator.totals());
      await this.refreshBaseline(state);
      this.updated(state);
    });
  }
  beginFrame(packet: TelemetryPacket): void {
    if (!(packet as TelemetryPacket & { [sourceCoordinate]?: number })[sourceCoordinate]) {
      (packet as TelemetryPacket & { [sourceCoordinate]?: number })[sourceCoordinate] = ++nextSourceCoordinate;
    }
  }
  private admission(state: StintState, packet: TelemetryPacket): () => Promise<SourceOrder> {
    this.beginFrame(packet);
    const coordinate = (packet as TelemetryPacket & { [sourceCoordinate]?: number })[sourceCoordinate]!;
    const sessionId = state.live.sessionId;
    const sourceEpoch = state.sourceEpoch;
    const key = `${sessionId}:${sourceEpoch}:${coordinate}`;
    let admission = this.admissions.get(key);
    if (!admission) {
      admission = { sessionId, sourceEpoch, coordinate, running: false, cancelled: false, waiters: [] };
      this.admissions.set(key, admission);
      this.admissionQueue.push(admission);
    }
    return () => {
      if (admission!.order) return Promise.resolve(admission!.order);
      const result = new Promise<SourceOrder>((resolve, reject) => admission!.waiters.push({ resolve, reject }));
      this.processAdmissions();
      return result;
    };
  }
  private processAdmissions(): void {
    const current = this.admissionQueue[0];
    if (!current || current.running) return;
    current.running = true;
    void admitStrategyObservation(current.sessionId, current.sourceEpoch, String(current.coordinate)).then((order) => {
      if (current.cancelled || this.admissionQueue[0] !== current) return;
      current.order = order;
      this.admissionQueue.shift();
      for (const waiter of current.waiters.splice(0)) waiter.resolve(order);
      this.processAdmissions();
    }, (failure: unknown) => {
      if (current.cancelled || this.admissionQueue[0] !== current) return;
      current.running = false;
      if (failure instanceof StaleStrategyIdentityError) {
        this.discardSession(current.sessionId);
        this.processAdmissions();
        return;
      }
      const error = failure instanceof Error ? failure : new Error(String(failure));
      for (const admission of this.admissionQueue) {
        for (const waiter of admission.waiters.splice(0)) waiter.reject(error);
      }
    });
  }
  observe(packet: TelemetryPacket): void {
    const state = this.active;
    if (!state || !this.session || packet.gameId !== this.session.gameId) return;
    const previous = this.previous;
    if (previous) {
      const boundary = this.boundaryTracker.observe(previous, packet);
      if (boundary) {
        if (packet.LapNumber === previous.LapNumber) this.crossedLaps.add(packet.LapNumber);
        if (boundary & StrategyBoundary.Rewind) this.epoch++;
        this.close(state, strategyBoundaryReason(boundary), "observed");
        this.tireReset ||= (boundary & StrategyBoundary.Tires) !== 0;
        this.createStint(packet);
      }
    }
    this.previous = packet;
    if (this.active) { this.active.lastPacket = packet; this.active.lastObservedAt = Date.now(); }
  }
  prepareLap(event: LapCompleteEvent): void {
    const state = this.active;
    const session = this.session;
    const first = event.packets[0];
    const last = event.packets.at(-1);
    if (!state || !session || !first || !last) return;
    const adapter = getServerGame(session.gameId);
    const metrics = aggregateLapMetrics(event.packets, { valid: event.isValid, lapTimeSeconds: event.lapTime,
      fuelUnit: adapter.telemetry.fuel.packetUnit === "fraction" ? "tankFraction" : "L",
      allowContinuousWear: strategyContinuousWear(adapter), serviceBoundary: this.crossedLaps.delete(first.LapNumber) });
    let resolve!: (event: LapSavedEvent) => void;
    let reject!: (error: Error) => void;
    const saved = new Promise<LapSavedEvent>((accept, fail) => { resolve = accept; reject = fail; });
    void saved.catch(() => {});
    const key = `${session.sessionId}:${event.lapNumber}`;
    const waiting = this.pending.get(key) ?? [];
    waiting.push({ state, resolve, reject });
    this.pending.set(key, waiting);
    const observedAt = new Date().toISOString();
    // Admission starts now, before waiting for the saved lap or deriving an estimate.
    const order = this.admission(state, last);
    void order().catch(() => {});
    let snapshot: StintSummary | null = null;
    this.enqueue(state, async () => {
      const savedEvent = await saved;
      if (this.processedLaps.has(savedEvent.lapId)) return;
      const sourceOrder = await order();
      const staged = state.accumulator.fork();
      snapshot = staged.add(savedEvent.lapNumber, metrics);
      const stagedState: StintState = { ...state, accumulator: staged };
      this.updateLive(stagedState);
      const estimate = metrics.fuelUsed != null || metrics.tireWear.some((value) => value != null)
        ? this.estimate(stagedState, last, sourceOrder, "lap-completed", observedAt, savedEvent.lapId, staged) : undefined;
      await persistStrategyLapMetrics({ sessionId: session.sessionId, driverKey: state.live.driverKey, lapId: savedEvent.lapId,
        stintId: state.live.stintId, algorithmVersion: STRATEGY_ALGORITHM_VERSION, contribution: metrics }, snapshot, staged.totals(), estimate);
      state.accumulator = staged;
      this.updateLive(state);
      this.processedLaps.add(savedEvent.lapId);
      this.updated(state);
    });
  }
  savedLap(event: LapSavedEvent): void {
    const key = `${event.sessionId}:${event.lapNumber}`;
    const queue = this.pending.get(key);
    const pending = queue?.shift();
    if (!pending) return;
    if (!queue?.length) this.pending.delete(key);
    pending.resolve(event);
  }
  lapWriteFailed(sessionId: number, lapNumber: number, error: Error): void {
    const key = `${sessionId}:${lapNumber}`;
    const queue = this.pending.get(key);
    const pending = queue?.shift();
    if (!pending) {
      if (this.active?.live.sessionId === sessionId) {
        this.persistenceError = true;
        this.updateLive(this.active);
      }
      return;
    }
    if (!queue?.length) this.pending.delete(key);
    pending.reject(new TerminalLapSaveError(error.message));
    this.persistenceError = true;
    pending.state.live.persistence = "error";
    void this.drain();
  }
  private updateLive(state: StintState, pendingHistory = false): void {
    const summary = state.accumulator.snapshot();
    const current = state.accumulator.rollingRates();
    const policy = getServerGame(summary.gameId).runtime.pit;
    const choose = (rate: MetricRate, prior: MetricRate | undefined, threshold: number, enabled: boolean): MetricRate => {
      if (rate.eligibleLaps >= threshold) return { ...rate, provisional: false };
      if (enabled && prior?.value != null) return prior;
      return { ...rate, provisional: rate.value != null, unavailableReason: rate.value == null ? pendingHistory || state.refreshing ? "history-refresh-pending" : enabled ? rate.unavailableReason : "history-disabled" : null };
    };
    state.live = { sessionId: summary.sessionId, driverKey: summary.driverKey, stintId: summary.id, revision: summary.revision,
      historyRevision: state.baseline?.historyRevision ?? state.expectedHistoryRevision,
      fuel: choose(current.fuel, state.baseline?.fuel, 2, policy.seedFuelFromHistory),
      tires: [choose(current.tires[0], state.baseline?.tires[0], 3, policy.seedTireWearFromHistory), choose(current.tires[1], state.baseline?.tires[1], 3, policy.seedTireWearFromHistory), choose(current.tires[2], state.baseline?.tires[2], 3, policy.seedTireWearFromHistory), choose(current.tires[3], state.baseline?.tires[3], 3, policy.seedTireWearFromHistory)],
      baseline: state.baseline, persistence: this.persistenceError ? "error" : "ok" };
  }
  private async refreshBaseline(state: StintState): Promise<void> {
    const generation = ++state.generation;
    state.refreshing = true;
    this.updateLive(state, true);
    try {
      const baseline = await getStrategyBaseline(state.accumulator.snapshot());
      if (generation !== state.generation || state !== this.active || baseline.historyRevision < state.expectedHistoryRevision) return;
      state.baseline = baseline; state.expectedHistoryRevision = baseline.historyRevision;
    } catch (error) { this.persistenceError = true; console.error("[Strategy] Historical evidence unavailable:", error); }
    finally { if (generation === state.generation) { state.refreshing = false; this.updateLive(state); } }
  }
  private enqueue(state: StintState, run: () => Promise<void>): void {
    this.jobs.push({ state, run });
    void this.drain();
  }
  private drain(): Promise<void> {
    if (this.draining) { this.drainRequested = true; return this.draining; }
    this.draining = (async () => {
      while (this.jobs.length) {
        const job = this.jobs[0];
        if (job.state.cancelled) { this.jobs.shift(); continue; }
        try {
          await job.run(); this.jobs.shift(); this.persistenceError = false;
          if (this.active) this.updateLive(this.active);
        } catch (error) {
          if (error instanceof TerminalLapSaveError) {
            this.persistenceError = true;
            this.jobs.shift();
            if (this.active) this.updateLive(this.active);
            continue;
          }
          if (error instanceof StaleStrategyIdentityError) { this.discardSession(job.state.live.sessionId); continue; }
          this.persistenceError = true;
          if (this.active) this.updateLive(this.active);
          console.error("[Strategy] Durable write failed:", error);
          break;
        }
      }
    })().finally(() => {
      this.draining = null;
      if (this.drainRequested) {
        this.drainRequested = false;
        void this.drain();
      }
    });
    return this.draining;
  }
  private updated(state: StintState): void {
    this.notify({ type: "strategy-updated", sessionId: state.live.sessionId, driverKey: state.live.driverKey, stintId: state.live.stintId, revision: state.live.revision });
  }
  private estimate(state: StintState, packet: TelemetryPacket, sourceOrder: SourceOrder, trigger: PitEstimateRecord["trigger"], observedAt: string, lapId: number | null, accumulator = state.accumulator): PitEstimateRecord {
    const projection: LivePitData = {
      fuelPerLap: 0, fuelLapsRemaining: null, currentLapFuelUsed: 0, tireLapsToBad: null, tireLapsToCritical: null,
      tireEstimates: { toCliff: [null,null,null,null], toDead: [null,null,null,null], wearPerLap: [0,0,0,0] },
      tireWearPerLap: 0, pitInLaps: null, limitedBy: null, trackLength: 0, estimateSource: null,
      cliffPct: getServerGame(packet.gameId).tireHealthThresholds.yellow * 100, deadPct: 20, tireLapsRemaining: null,
    };
    const pit = this.project(packet, projection, state);
    const summary = accumulator.snapshot();
    const sessionElapsed = Number.isFinite(packet.CurrentRaceTime) && packet.CurrentRaceTime > 0 ? packet.CurrentRaceTime : null;
    const snapshotWear = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
    return { id: `estimate-${summary.sessionId}-${summary.driverKey}-${sourceOrder.epochOrdinal}-${sourceOrder.sequence}`,
      sessionId: summary.sessionId, driverKey: summary.driverKey, stintId: summary.id, observedAt, sourceOrder,
      gameId: summary.gameId, trackId: summary.trackId, carId: summary.carId, pi: summary.pi, compounds: summary.compounds,
      sourceCoordinate: { epoch: state.sourceEpoch, domain: "session", milliseconds: packet.TimestampMS }, trigger,
      pitInLaps: pit.pitInLaps, limitedBy: pit.limitedBy,
      estimatedPitTime: { sessionElapsedSeconds: sessionElapsed != null && pit.pitInLaps != null && summary.averageLapSeconds != null
        ? sessionElapsed + pit.pitInLaps * summary.averageLapSeconds : null },
      tyreChangeSuggestion: state.live.tires.every((rate) => rate.value == null) ? "unavailable" : pit.limitedBy === "tires" ? "consider-change" : "not-indicated",
      fuelChangeSuggestion: !supportsRaceRefueling(summary.gameId) ? "not-indicated" : state.live.fuel.value == null ? "unavailable" : pit.limitedBy === "fuel" ? "consider-refuel" : "not-indicated",
      fuel: structuredClone(state.live.fuel), tires: structuredClone(state.live.tires),
      sourceSnapshot: { fuelRemaining: Number.isFinite(packet.Fuel) && packet.Fuel >= 0 && (summary.fuelUnit === "L" || packet.Fuel <= 1) ? packet.Fuel : null, fuelUnit: summary.fuelUnit,
        wear: [snapshotWear(packet.TireWearFL),snapshotWear(packet.TireWearFR),snapshotWear(packet.TireWearRL),snapshotWear(packet.TireWearRR)], lapId },
      compatibility: summary.compatibility, baseline: state.baseline ? structuredClone(state.baseline) : null, algorithmVersion: STRATEGY_ALGORITHM_VERSION };
  }
  private close(state: StintState, reason: string, confidence: StintSummary["boundary"]["confidence"]): void {
    const packet = state.lastPacket;
    const observedAt = new Date(state.lastObservedAt).toISOString();
    const order = this.admission(state, packet);
    void order().catch(() => {});
    let summary: StintSummary | null = null;
    this.enqueue(state, async () => {
      summary ??= state.accumulator.close(reason, confidence, observedAt);
      await closeStrategyStint(summary);
      this.updateLive(state);
      await savePitEstimate(this.estimate(state, packet, await order(), "stint-ended", observedAt, null));
      this.updated(state);
    });
  }
  async finish(): Promise<void> {
    if (this.active) { this.close(this.active, "session-ended", "observed"); this.active = null; }
    await this.drain();
    this.previous = null;
    this.boundaryTracker.reset();
  }
  /** Await admitted writes without inventing a stint-end event. */
  async flush(): Promise<void> { await this.drain(); }
  /** Reserve the last received source point before a clear can advance its watermark. */
  async admitClearBoundary(sessionId: number, driverKey: string): Promise<void> {
    const state = this.active;
    if (!state || state.live.sessionId !== sessionId || state.live.driverKey !== driverKey) return;
    await this.admission(state, state.lastPacket)();
  }
  bindCaptureEpoch(epoch: string): void {
    this.captureEpoch = epoch;
    if (this.active) this.active.sourceEpoch = `${epoch}:${this.epoch}`;
  }
  discardSession(sessionId: number): void {
    const error = new StaleStrategyIdentityError("Strategy source was invalidated");
    for (const [key, admission] of this.admissions) {
      if (admission.sessionId !== sessionId) continue;
      admission.cancelled = true;
      this.admissions.delete(key);
      for (const waiter of admission.waiters.splice(0)) waiter.reject(error);
    }
    this.admissionQueue = this.admissionQueue.filter((admission) => admission.sessionId !== sessionId);
    for (const job of this.jobs) if (job.state.live.sessionId === sessionId) job.state.cancelled = true;
    for (const [key, queue] of this.pending) {
      const retained: PendingLap[] = [];
      for (const pending of queue) {
        if (pending.state.live.sessionId === sessionId) pending.reject(new StaleStrategyIdentityError("Strategy source was invalidated"));
        else retained.push(pending);
      }
      if (retained.length) this.pending.set(key, retained); else this.pending.delete(key);
    }
    if (this.active?.live.sessionId === sessionId) { this.active.cancelled = true; this.active = null; this.session = null; this.previous = null; this.boundaryTracker.reset(); }
    this.processAdmissions();
  }
  consumeTireReset(): boolean { const reset = this.tireReset; this.tireReset = false; return reset; }
  private project(packet: TelemetryPacket, pit: LivePitData, state: StintState): LivePitData {
    const live = state.live;
    // Saved estimates start without PitTracker's frame projection.
    if (!pit.tireThresholds) {
      const overrides = getTireThresholdOverrides();
      pit.tireThresholds = [
        getTireThresholds(overrides, packet.gameId, getPacketTireCompound(packet, 0)),
        getTireThresholds(overrides, packet.gameId, getPacketTireCompound(packet, 1)),
        getTireThresholds(overrides, packet.gameId, getPacketTireCompound(packet, 2)),
        getTireThresholds(overrides, packet.gameId, getPacketTireCompound(packet, 3)),
      ];
      pit.cliffPct = pit.tireThresholds.reduce((sum, value) => sum + value.cliffPct, 0) / 4;
      pit.deadPct = pit.tireThresholds.reduce((sum, value) => sum + value.deadPct, 0) / 4;
    }
    const fuelRate = live.fuel.value;
    const supportsRefueling = supportsRaceRefueling(packet.gameId);
    pit.fuelPerLap = fuelRate ?? 0;
    pit.fuelLapsRemaining = supportsRefueling && fuelRate != null && fuelRate > 0 && Number.isFinite(packet.Fuel) && packet.Fuel >= 0 ? packet.Fuel / fuelRate : null;
    const cliff: [number | null, number | null, number | null, number | null] = [null, null, null, null];
    const dead: typeof cliff = [null, null, null, null];
    const rates: [number, number, number, number] = [0, 0, 0, 0];
    for (let wheel = 0; wheel < 4; wheel++) {
      const rate = live.tires[wheel].value;
      const wear = packet[wheels[wheel]];
      if (rate == null || !Number.isFinite(wear) || wear < 0 || wear > 1) continue;
      rates[wheel] = rate;
      const thresholds = pit.tireThresholds?.[wheel];
      if (!thresholds) continue;
      const toCliff = Math.max(0, 1 - thresholds.cliffPct / 100 - wear);
      const toDead = Math.max(0, 1 - thresholds.deadPct / 100 - wear);
      cliff[wheel] = toCliff === 0 ? 0 : rate > 0 ? toCliff / rate : null;
      dead[wheel] = toDead === 0 ? 0 : rate > 0 ? toDead / rate : null;
      if (getServerGame(packet.gameId).runtime.pit.useDistanceBasedWearCurves && live.tires[wheel].source === "current-stint" && !live.tires[wheel].provisional) {
        cliff[wheel] = pit.tireEstimates?.toCliff[wheel] ?? cliff[wheel];
        dead[wheel] = pit.tireEstimates?.toDead[wheel] ?? dead[wheel];
      }
    }
    const availableCliff = cliff.filter((value): value is number => value != null);
    const availableDead = dead.filter((value): value is number => value != null);
    pit.tireLapsToBad = availableCliff.length ? Math.min(...availableCliff) : null;
    pit.tireLapsToCritical = availableDead.length ? Math.min(...availableDead) : null;
    pit.tireLapsRemaining = pit.tireLapsToBad;
    pit.tireEstimates = { toCliff: cliff, toDead: dead, wearPerLap: rates };
    pit.tireWearPerLap = Math.max(...rates);
    pit.limitedBy = pit.fuelLapsRemaining == null ? pit.tireLapsToBad == null ? null : "tires" : pit.tireLapsToBad == null || pit.fuelLapsRemaining <= pit.tireLapsToBad ? "fuel" : "tires";
    pit.pitInLaps = pit.limitedBy === "fuel" ? pit.fuelLapsRemaining : pit.limitedBy === "tires" ? pit.tireLapsToBad : null;
    pit.strategy = live;
    pit.estimateSource = live.fuel.source === "history" && live.tires.every((rate) => rate.source !== "current-stint") ? "history" : live.fuel.source === "current-stint" && live.tires.every((rate) => rate.source !== "history") ? "session" : null;
    return pit;
  }
  apply(packet: TelemetryPacket, pit: LivePitData): LivePitData {
    const state = this.active;
    if (!state) return pit;
    this.project(packet, pit, state);
    if (pit.limitedBy !== this.lastLimiter) {
      this.lastLimiter = pit.limitedBy;
      const observedAt = new Date().toISOString();
      const order = this.admission(state, packet);
      void order().catch(() => {});
      this.enqueue(state, async () => {
        if (await savePitEstimate(this.estimate(state, packet, await order(), "limiter-changed", observedAt, null))) this.updated(state);
      });
    }
    return pit;
  }
  dispose(): void { this.unsubscribe(); }
}
