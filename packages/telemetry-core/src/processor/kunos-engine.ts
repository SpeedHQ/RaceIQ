import type { DetectorOwnershipState, DetectorOwnershipTransition, DetectorOwnershipWindow } from "./ordinal-engine";
import { getKunosLapResetEvidence, isKunosCompletedLapReset, isKunosPreLapTimerReset, kunosFirstPacketIsMidLap } from "./kunos-policy";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

export interface KunosLapCapture {
  processorSessionKey: number;
  packets: TelemetryPacket[];
  trigger?: TelemetryPacket;
  lapNumber: number;
  lapTime: number;
  byteOffset: number | null;
  frameCount: number;
  silent: boolean;
  invalidReason?: string;
}

export interface KunosEngineOptions {
  createSession(packet: TelemetryPacket): Promise<void>;
  onSessionStarted?(packet: TelemetryPacket): void | Promise<void>;
  backfillSessionIdentifiers(packet: TelemetryPacket): void | Promise<void>;
  isPitOnly(packets: readonly TelemetryPacket[]): boolean;
  isOpenRoute?(packet: TelemetryPacket): boolean;
  emitLap(capture: KunosLapCapture): Promise<void>;
  now?(): number;
}

/** Instance-local ACC/AC Evo transition and capture state. Host effects remain callbacks. */
export class KunosDetectorEngine {
  private readonly options: KunosEngineOptions;
  private sessionSequence = 0;
  private sessionKey: number | null = null;
  private lapBuffer: TelemetryPacket[] = [];
  private currentLapNumber = -1;
  private peakCurrentLap = 0;
  private firstLapIsPartial = false;
  private lastEmittedLapNumber = -1;
  private lapByteOffset: number | null = null;
  private lapFrameCount = 0;
  private currentFeedHasRawOffset = false;
  private currentRawByteOffset: number | null = null;
  private currentRawOrdinal: number | null = null;
  private lapStartOrdinal: number | null = null;
  private currentFeedRawOrdinal: number | null = null;
  private lastActivePacketTime = 0;
  private openRouteActive = false;
  private openRoutePendingFinish = false;
  private openRouteStartNextPacket = false;
  private openRoutePreviousPacket: TelemetryPacket | null = null;
  private ownershipRevision = 0;
  private ownershipWindows: DetectorOwnershipWindow[] = [];
  private ownershipListeners = new Set<(transition: DetectorOwnershipTransition) => void>();
  private pendingOwnershipTransitions: DetectorOwnershipTransition[] = [];
  private lastCandidateOrdinal: number | null = null;
  private ownershipTrackingEnabled = false;

  constructor(options: KunosEngineOptions) { this.options = options; }
  get isActive(): boolean { return this.sessionKey !== null; }
  getOwnershipState(): DetectorOwnershipState {
    const active = this.lapBuffer.length > 0 || this.openRouteActive
      ? [this.ownershipWindow("provisional")] : [];
    return Object.freeze({
      revision: this.ownershipRevision,
      watermarkOffset: this.lapByteOffset,
      nextWindowStartOffset: this.lapByteOffset,
      windows: Object.freeze([...this.ownershipWindows, ...active]),
    });
  }
  subscribeOwnership(listener: (transition: DetectorOwnershipTransition) => void): () => void {
    this.ownershipTrackingEnabled = true;
    this.ownershipListeners.add(listener);
    return () => this.ownershipListeners.delete(listener);
  }
  drainOwnershipTransitions(): DetectorOwnershipTransition[] {
    const transitions = this.pendingOwnershipTransitions;
    this.pendingOwnershipTransitions = [];
    for (const transition of transitions) {
      for (const listener of this.ownershipListeners) listener(transition);
    }
    return transitions;
  }
  private publishOwnership(kind: DetectorOwnershipTransition["kind"], window: DetectorOwnershipWindow | null): void {
    if (!this.ownershipTrackingEnabled) return;
    this.ownershipRevision++;
    if (window && (kind === "window-finalized" || kind === "final-incomplete")) this.ownershipWindows = [...this.ownershipWindows.slice(-1), window];
    const state = this.getOwnershipState();
    const transition = Object.freeze({ revision: this.ownershipRevision, kind, window, state });
    const previous = this.pendingOwnershipTransitions.at(-1);
    if ((kind === "snapshot" || kind === "auxiliary-watermark") && previous &&
      (previous.kind === "snapshot" || previous.kind === "auxiliary-watermark")) this.pendingOwnershipTransitions.pop();
    if (this.pendingOwnershipTransitions.length >= 256) throw new Error("Kunos ownership transition queue exceeded 256; source ownership consumer is not draining");
    this.pendingOwnershipTransitions.push(transition);
  }
  private ownershipWindow(status: DetectorOwnershipWindow["status"]): DetectorOwnershipWindow {
    const frameCount = this.lapStartOrdinal !== null && this.currentRawOrdinal !== null
      ? Math.max(0, this.currentRawOrdinal - this.lapStartOrdinal + 1) : this.lapFrameCount;
    return Object.freeze({
      revision: this.ownershipRevision + 1, lapNumber: Math.max(0, this.currentLapNumber),
      startOffset: this.lapByteOffset, startOrdinal: this.lapStartOrdinal, frameCount,
      status, trailingContextFrameCount: 0, bounded: true,
    });
  }
  observeSourceRecord(offset: number, _endOffset: number, ordinal: number): void {
    this.ownershipTrackingEnabled = true;
    this.currentRawByteOffset = offset;
    this.currentRawOrdinal = ordinal;
    if (this.lapBuffer.length > 0 || this.openRouteActive) this.publishOwnership("snapshot", null);
  }
  setCurrentLapByteOffset(offset: number, rawOrdinal?: number): void {
    this.ownershipTrackingEnabled = true;
    const previousStartOrdinal = this.lapStartOrdinal;
    this.lapByteOffset = offset; this.currentRawByteOffset = offset;
    if (rawOrdinal !== undefined) {
      this.currentRawOrdinal = rawOrdinal;
      this.currentFeedRawOrdinal = rawOrdinal;
      this.lapStartOrdinal = rawOrdinal;
      this.lapFrameCount = 1;
      this.currentFeedHasRawOffset = true;
    } else {
      this.lapFrameCount = 1;
      this.lapStartOrdinal = this.currentRawOrdinal;
    }
    this.pendingOwnershipTransitions = this.pendingOwnershipTransitions.map(transition => {
      if (transition.kind !== "window-start" && transition.kind !== "snapshot") return transition;
      const window = transition.window
        ? Object.freeze({ ...transition.window, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, frameCount: 1 }) })
        : null;
      const state = Object.freeze({
        ...transition.state,
        watermarkOffset: offset,
        nextWindowStartOffset: offset,
        windows: Object.freeze(transition.state.windows.map(item =>
          item.status === "provisional" && item.startOrdinal === previousStartOrdinal
            ? Object.freeze({ ...item, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, frameCount: 1 }) })
            : item,
        )),
      });
      return Object.freeze({ ...transition, window, state });
    });
    if (this.lapBuffer.length > 0 || this.openRouteActive) this.publishOwnership("window-start", this.ownershipWindow("provisional"));
  }
  shouldCheckpoint(packet: TelemetryPacket): boolean {
    if (this.sessionKey === null) return true;
    if (this.options.isOpenRoute?.(packet)) {
      const previous = this.openRoutePreviousPacket;
      const timerReset = previous !== null && previous.CurrentLap > 2 && packet.CurrentLap <= 2;
      const validRunning = packet.IsRaceOn === 1 && packet.acc?.isValidLap === true;
      const startCandidate = !this.openRouteActive && validRunning && packet.CurrentLap <= 2
        && (timerReset || previous === null || this.openRouteStartNextPacket);
      if (startCandidate) { this.publishCandidateStart(packet); return true; }
      if (this.openRoutePendingFinish && packet.LastLap > 0) return true;
      const previousTimed = this.lapBuffer[this.lapBuffer.length - 1];
      if (previousTimed && packet.DistanceTraveled < previousTimed.DistanceTraveled - 100) {
        this.publishCandidateStart(packet); return true;
      }
      if (this.openRouteActive && previous !== null && packet.LapNumber > previous.LapNumber) {
        this.publishCandidateStart(packet); return true;
      }
      if (this.openRouteActive && timerReset) { this.publishCandidateStart(packet); return true; }
      return false;
    }
    const prev = this.lapBuffer[this.lapBuffer.length - 1];
    if (!prev) return false;
    if (packet.DistanceTraveled < prev.DistanceTraveled - 100) { this.publishCandidateStart(packet); return true; }
    const evidence = getKunosLapResetEvidence(prev, packet, this.currentLapNumber);
    const candidate = isKunosPreLapTimerReset(prev, evidence) || isKunosCompletedLapReset(prev, evidence);
    if (candidate) this.publishCandidateStart(packet);
    return candidate;
  }
  private publishCandidateStart(packet: TelemetryPacket): void {
    if (this.currentRawOrdinal !== null && this.currentRawOrdinal === this.lastCandidateOrdinal) return;
    this.lastCandidateOrdinal = this.currentRawOrdinal;
    const window = Object.freeze({
      revision: this.ownershipRevision + 1, lapNumber: Math.max(0, packet.LapNumber),
      startOffset: this.currentRawByteOffset, startOrdinal: this.currentRawOrdinal,
      frameCount: 0, status: "provisional" as const, trailingContextFrameCount: 0,
      bounded: true as const, preparationOnly: true as const,
    });
    this.publishOwnership("candidate-start", window);
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void> {
    this.lastActivePacketTime = (this.options.now ?? Date.now)();
    this.currentFeedHasRawOffset = rawByteOffset !== undefined || rawOrdinal !== undefined;
    this.currentFeedRawOrdinal = rawOrdinal ?? this.currentRawOrdinal;
    if (rawOrdinal !== undefined) this.currentRawOrdinal = rawOrdinal;
    if (rawByteOffset !== undefined) {
      if (this.currentRawByteOffset === null) this.lapByteOffset = rawByteOffset;
      this.currentRawByteOffset = rawByteOffset;
      if (this.currentRawOrdinal === null) this.lapFrameCount++;
    }
    if (this.sessionKey === null) {
      await this.options.createSession(packet);
      this.sessionKey = ++this.sessionSequence;
      this.currentLapNumber = this.options.isOpenRoute?.(packet) ? 1 : (packet.LapNumber ?? 0) > 0 ? packet.LapNumber! : 1;
      this.firstLapIsPartial = kunosFirstPacketIsMidLap(packet);
      this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
      this.lapStartOrdinal = this.currentFeedRawOrdinal;
      await this.options.onSessionStarted?.(packet);
    }
    const backfill = this.options.backfillSessionIdentifiers(packet);
    if (backfill) await backfill;
    if (this.lapBuffer.length > 0 || this.openRouteActive) this.publishOwnership("snapshot", null);
    if (this.options.isOpenRoute?.(packet)) {
      const previous = this.openRoutePreviousPacket;
      this.openRoutePreviousPacket = packet;
      const timerReset = previous !== null && previous.CurrentLap > 2 && packet.CurrentLap <= 2;
      const validRunning = packet.IsRaceOn === 1 && packet.acc?.isValidLap === true;
      if (!this.openRouteActive) {
        const startNext = this.openRouteStartNextPacket;
        this.openRouteStartNextPacket = false;
        if (validRunning && packet.CurrentLap <= 2 && (timerReset || previous === null || startNext)) {
          this.openRouteActive = true;
          this.openRoutePendingFinish = false;
          this.lapBuffer = [packet];
          this.peakCurrentLap = packet.CurrentLap;
          this.lapByteOffset = this.currentRawByteOffset;
          this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
          this.lapStartOrdinal = this.currentFeedRawOrdinal;
          this.publishOwnership("window-start", this.ownershipWindow("provisional"));
        } else {
          this.lapBuffer = [];
        }
        return;
      }
      if (this.openRoutePendingFinish) {
        if (packet.LastLap > 0) {
          await this.emit(false, packet, true);
          this.openRouteActive = false;
          this.openRoutePendingFinish = false;
          this.openRouteStartNextPacket = packet.CurrentLap <= 2;
        } else {
          this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        }
        return;
      }
      const previousTimed = this.lapBuffer[this.lapBuffer.length - 1];
      if (previousTimed && packet.DistanceTraveled < previousTimed.DistanceTraveled - 100) {
        this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        await this.emit(false, undefined, false, "car reset");
        this.openRouteActive = false;
        this.openRoutePendingFinish = false;
        this.openRouteStartNextPacket = validRunning && packet.CurrentLap <= 2;
        return;
      }
      if (previousTimed && packet.LapNumber > previousTimed.LapNumber) {
        if (packet.LastLap > 0) {
          await this.emit(false, packet, true);
          this.openRouteActive = false;
          this.openRouteStartNextPacket = packet.CurrentLap <= 2;
        } else {
          this.lapBuffer.push(packet);
          this.openRoutePendingFinish = true;
        }
        return;
      }
      if (timerReset) {
        this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        await this.emit(false, undefined, false, "car reset");
        this.openRouteActive = false;
        this.openRoutePendingFinish = false;
        this.openRouteStartNextPacket = validRunning && packet.CurrentLap <= 2;
        return;
      }
      this.lapBuffer.push(packet);
      this.updatePeak(packet);
      return;
    }
    const prev = this.lapBuffer[this.lapBuffer.length - 1];
    if (prev && packet.DistanceTraveled < prev.DistanceTraveled - 100) {
      this.resetCapture(rawByteOffset); this.lapBuffer.push(packet); this.updatePeak(packet);
      this.publishOwnership("window-start", this.ownershipWindow("provisional")); return;
    }
    if (!prev) {
      this.lapBuffer.push(packet); this.updatePeak(packet);
      if (this.lapByteOffset !== null) this.publishOwnership("window-start", this.ownershipWindow("provisional"));
      return;
    }
    const evidence = getKunosLapResetEvidence(prev, packet, this.currentLapNumber);
    if (isKunosPreLapTimerReset(prev, evidence)) {
      const abandoned = this.ownershipWindow("incomplete");
      this.publishOwnership("window-abandoned", Object.freeze({
        ...abandoned, frameCount: Math.max(0, abandoned.frameCount - 1),
      }));
      this.lapBuffer = [packet]; this.peakCurrentLap = packet.CurrentLap; this.firstLapIsPartial = false;
      this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
      this.lapStartOrdinal = this.currentFeedRawOrdinal;
      this.publishOwnership("window-start", this.ownershipWindow("provisional")); return;
    }
    if (isKunosCompletedLapReset(prev, evidence)) {
      if (this.firstLapIsPartial) {
        const distance = (this.lapBuffer[this.lapBuffer.length - 1]?.DistanceTraveled ?? 0) - (this.lapBuffer[0]?.DistanceTraveled ?? 0);
        if (distance < 100 || this.options.isPitOnly(this.lapBuffer)) {
          this.resetCapture(rawByteOffset); this.lapBuffer.push(packet); this.updatePeak(packet); return;
        }
        this.firstLapIsPartial = false;
      }
      await this.emit(false, packet);
    }
    this.lapBuffer.push(packet); this.updatePeak(packet);
  }
  async flushIncompleteLap(): Promise<void> {
    if (!this.isActive || this.lapBuffer.length < 10) return;
    await this.emit(true);
    this.lapBuffer = []; this.peakCurrentLap = 0;
    this.openRouteActive = false; this.openRoutePendingFinish = false; this.openRouteStartNextPacket = false;
  }
  async flushStaleLap(): Promise<boolean> {
    if (!this.isActive || !this.lastActivePacketTime || (this.options.now ?? Date.now)() - this.lastActivePacketTime < 10_000) return false;
    await this.finalize(); return true;
  }
  async finalize(): Promise<void> {
    if (this.sessionKey === null) return;
    if (this.lapBuffer.length >= 10) await this.emit(true);
    else if (this.lapBuffer.length > 0) {
      this.publishAbandonedWindow();
    }
    this.sessionKey = null; this.lapBuffer = []; this.peakCurrentLap = 0; this.firstLapIsPartial = false;
    this.lapByteOffset = null; this.currentRawByteOffset = null; this.lapFrameCount = 0; this.lapStartOrdinal = null;
    this.lastActivePacketTime = 0; this.lastEmittedLapNumber = -1; this.currentLapNumber = -1;
    this.openRouteActive = false; this.openRoutePendingFinish = false; this.openRouteStartNextPacket = false; this.openRoutePreviousPacket = null;
  }
  private resetCapture(rawByteOffset?: number): void {
    if (this.lapBuffer.length > 0) {
      this.publishAbandonedWindow();
    }
    this.lapBuffer = []; this.peakCurrentLap = 0; this.firstLapIsPartial = false;
    this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
    this.lapStartOrdinal = this.currentFeedRawOrdinal;
  }
  private publishAbandonedWindow(): void {
    const abandoned = this.ownershipWindow("incomplete");
    if (abandoned.startOffset !== null && abandoned.frameCount > 0) this.publishOwnership("window-abandoned", abandoned);
  }
  private updatePeak(packet: TelemetryPacket): void { if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap; }
  private async emit(silent: boolean, trigger?: TelemetryPacket, useReportedTime = false, invalidReason?: string): Promise<void> {
    const buffered = this.lapBuffer[this.lapBuffer.length - 1]?.LastLap ?? 0;
    const reported = trigger?.LastLap ?? 0;
    const lapTime = reported > 0 && (useReportedTime || reported !== buffered) ? reported : this.peakCurrentLap;
    const lapNumber = this.currentLapNumber;
    if (lapNumber === this.lastEmittedLapNumber) return;
    this.lastEmittedLapNumber = lapNumber;
    const packets = this.lapBuffer;
    if (trigger) packets.push(trigger);
    const byteOffset = this.lapByteOffset;
    const endOrdinal = trigger || invalidReason === "car reset" ? this.currentFeedRawOrdinal : this.currentRawOrdinal;
    const excludesCurrent = (trigger !== undefined || invalidReason === "car reset") &&
      this.currentFeedHasRawOffset && this.currentFeedRawOrdinal !== null;
    const frameCount = this.lapStartOrdinal !== null && endOrdinal !== null
      ? Math.max(0, endOrdinal - this.lapStartOrdinal + 1 - (excludesCurrent ? 1 : 0))
      : Math.max(0, this.lapFrameCount - (excludesCurrent ? 1 : 0));
    const status = silent ? "incomplete" : "final";
    if (byteOffset !== null && frameCount > 0) {
      this.publishOwnership(silent ? "final-incomplete" : "window-finalized", Object.freeze({
        revision: this.ownershipRevision + 1, lapNumber, startOffset: byteOffset,
        startOrdinal: this.lapStartOrdinal, frameCount,
        status, trailingContextFrameCount: excludesCurrent ? 1 : 0, bounded: true,
      }));
    }
    this.lapBuffer = []; this.peakCurrentLap = 0; this.currentLapNumber = lapNumber + 1;
    this.lapByteOffset = this.currentFeedHasRawOffset ? this.currentRawByteOffset : null;
    this.lapFrameCount = this.currentFeedHasRawOffset ? 1 : 0;
    this.lapStartOrdinal = this.currentFeedHasRawOffset ? this.currentFeedRawOrdinal : null;
    if (trigger && this.lapByteOffset !== null) this.publishOwnership("window-start", this.ownershipWindow("provisional"));
    await this.options.emitLap({ processorSessionKey: this.sessionKey!, packets, trigger, lapNumber, lapTime, byteOffset, frameCount, silent, invalidReason });
  }
}
