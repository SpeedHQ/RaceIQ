import type { DetectorOwnershipState, DetectorOwnershipTransition, DetectorOwnershipWindow } from "./ordinal-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

interface DeferredPacket { packet: TelemetryPacket; rawByteOffset?: number; rawOrdinal?: number }
const MAX_DEFERRED_PACKETS = 1_200;
export interface IRacingEngineOptions {
  now(): number;
  feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void>;
  flushStaleLap(): Promise<void>;
  finalizeCurrentSession(): Promise<void>;
  observeSourceRecord?(offset: number, endOffset: number, ordinal: number): void;
  drainOwnershipTransitions?(): DetectorOwnershipTransition[];
  getOwnershipState?(): DetectorOwnershipState;
}

/** iRacing's delayed authoritative LastLap gate. Persistence and lap lifecycle stay host-owned. */
export class IRacingDetectorEngine {
  private sessionKey: string | undefined;
  private physicalLap: number | null = null;
  private skipFirstCompletion = true;
  private completeInitialLapExpected = false;
  private deferred: DeferredPacket[] = [];
  private pendingUnexpectedLap: DeferredPacket | null = null;
  private staleLastLap = 0;
  private peakNativeCurrentLap = 0;
  private lastActivePacketTime = 0;
  private readonly options: IRacingEngineOptions;
  private currentRawByteOffset: number | null = null;
  private currentRawOrdinal: number | null = null;
  private lastCandidateOrdinal: number | null = null;
  private ownershipTrackingEnabled = false;
  private pendingOwnershipTransitions: DetectorOwnershipTransition[] = [];
  constructor(options: IRacingEngineOptions) {
    this.options = options;
  }
  observeSourceRecord(offset: number, endOffset: number, ordinal: number): void {
    this.ownershipTrackingEnabled = true;
    this.currentRawByteOffset = offset;
    this.currentRawOrdinal = ordinal;
    this.options.observeSourceRecord?.(offset, endOffset, ordinal);
    if (this.deferred.length > 0) this.publishOwnership("snapshot", null);
  }
  expectCompleteLapStart(): void { this.completeInitialLapExpected = true; }
  getOwnershipState(): DetectorOwnershipState {
    const base = this.options.getOwnershipState?.();
    const deferredWindow = this.deferred.length > 0 ? this.deferredOwnershipWindow("provisional") : null;
    const watermarks = [deferredWindow?.startOffset, base?.watermarkOffset]
      .filter((offset): offset is number => offset !== null && offset !== undefined);
    return Object.freeze({
      revision: Math.max(this.ownershipRevision, base?.revision ?? 0),
      watermarkOffset: watermarks.length > 0 ? Math.min(...watermarks) : null,
      nextWindowStartOffset: deferredWindow?.startOffset ?? base?.nextWindowStartOffset ?? null,
      windows: Object.freeze([...(base?.windows ?? []), ...(deferredWindow ? [deferredWindow] : [])]),
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
    for (const transition of this.options.drainOwnershipTransitions?.() ?? []) {
      this.ownershipRevision = Math.max(this.ownershipRevision, transition.revision) + 1;
      const window = transition.window
        ? Object.freeze({ ...transition.window, revision: this.ownershipRevision }) : null;
      transitions.push(Object.freeze({
        revision: this.ownershipRevision, kind: transition.kind, window, state: this.getOwnershipState(),
      }));
    }
    for (const transition of transitions) {
      for (const listener of this.ownershipListeners) listener(transition);
    }
    return transitions;
  }
  private ownershipRevision = 0;
  private ownershipListeners = new Set<(transition: DetectorOwnershipTransition) => void>();
  private publishOwnership(kind: DetectorOwnershipTransition["kind"], window: DetectorOwnershipWindow | null): void {
    if (!this.ownershipTrackingEnabled) return;
    this.ownershipRevision = Math.max(this.ownershipRevision, this.options.getOwnershipState?.().revision ?? 0) + 1;
    const publishedWindow = window && kind !== "snapshot"
      ? Object.freeze({ ...window, revision: this.ownershipRevision }) : window;
    const state = this.getOwnershipState();
    const transition = Object.freeze({ revision: this.ownershipRevision, kind, window: publishedWindow, state });
    const previous = this.pendingOwnershipTransitions.at(-1);
    if ((kind === "snapshot" || kind === "auxiliary-watermark") && previous &&
      (previous.kind === "snapshot" || previous.kind === "auxiliary-watermark")) this.pendingOwnershipTransitions.pop();
    if (this.pendingOwnershipTransitions.length >= 256) throw new Error("iRacing ownership transition queue exceeded 256; source ownership consumer is not draining");
    this.pendingOwnershipTransitions.push(transition);
  }
  getDebugState(): Record<string, unknown> {
    return { iracingPhysicalLap: this.physicalLap, iracingDeferredPackets: this.deferred.length,
      iracingWaitingForNativeTime: this.deferred.length > 0,
      iracingPendingUnexpectedLap: this.pendingUnexpectedLap?.packet.LapNumber ?? null };
  }
  shouldCheckpoint(packet: TelemetryPacket): boolean {
    if (packet.sessionUID !== this.sessionKey) return true;
    if (this.physicalLap === null) return true;
    if (packet.LapNumber !== this.physicalLap) { this.publishCandidateStart(packet); return true; }
    if (this.pendingUnexpectedLap?.packet.LapNumber === packet.LapNumber) {
      this.publishCandidateStart(packet); return true;
    }
    return false;
  }
  setCurrentLapByteOffset(offset: number, rawOrdinal?: number): void {
    this.ownershipTrackingEnabled = true;
    const previousStartOrdinal = this.deferred[0]?.rawOrdinal ?? this.currentRawOrdinal;
    this.currentRawByteOffset = offset;
    if (rawOrdinal !== undefined) {
      this.currentRawOrdinal = rawOrdinal;
      const first = this.deferred[0];
      if (first) this.deferred[0] = { ...first, rawByteOffset: offset, rawOrdinal };
    }
    this.pendingOwnershipTransitions = this.pendingOwnershipTransitions.map(transition => {
      if (transition.kind !== "window-start" && transition.kind !== "snapshot" && transition.kind !== "candidate-start") return transition;
      const window = transition.window
        ? Object.freeze({ ...transition.window, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, ...(transition.window.preparationOnly ? {} : { frameCount: 1 }) }) })
        : null;
      const state = Object.freeze({
        ...transition.state,
        watermarkOffset: offset,
        nextWindowStartOffset: offset,
        windows: Object.freeze(transition.state.windows.map(item =>
          item.status === "provisional" && item.startOrdinal === previousStartOrdinal
            ? Object.freeze({ ...item, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, ...(item.preparationOnly ? {} : { frameCount: 1 }) }) })
            : item,
        )),
      });
      return Object.freeze({ ...transition, window, state });
    });
  }
  private publishCandidateStart(packet: TelemetryPacket): void {
    if (this.currentRawOrdinal !== null && this.currentRawOrdinal === this.lastCandidateOrdinal) return;
    this.lastCandidateOrdinal = this.currentRawOrdinal;
    const window = Object.freeze({
      revision: this.ownershipRevision + 1, lapNumber: packet.LapNumber,
      startOffset: this.currentRawByteOffset, startOrdinal: this.currentRawOrdinal,
      frameCount: 0, status: "provisional" as const, trailingContextFrameCount: 0,
      bounded: true as const, preparationOnly: true as const,
      holdForResolution: true as const,
    });
    this.publishOwnership("candidate-start", window);
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void> {
    this.lastActivePacketTime = this.options.now();
    if (rawByteOffset !== undefined) this.currentRawByteOffset = rawByteOffset;
    if (rawOrdinal !== undefined) this.currentRawOrdinal = rawOrdinal;
    const sourceOffset = rawByteOffset ?? this.currentRawByteOffset ?? undefined;
    const sourceOrdinal = rawOrdinal ?? this.currentRawOrdinal ?? undefined;
    if (packet.sessionUID !== this.sessionKey) {
      await this.releaseDeferredIncomplete();
      if (this.pendingUnexpectedLap) this.abandonUnexpected(this.pendingUnexpectedLap);
      this.pendingUnexpectedLap = null;
      this.resetGate(packet);
      await this.options.feed(packet, sourceOffset, sourceOrdinal);
      return;
    }
    if (this.pendingUnexpectedLap) {
      const pending = this.pendingUnexpectedLap;
      this.pendingUnexpectedLap = null;
      if (packet.LapNumber === pending.packet.LapNumber) await this.acceptUnexpectedLap(pending);
      else this.abandonUnexpected(pending);
    }
    if (this.physicalLap === null) { this.physicalLap = packet.LapNumber; await this.options.feed(packet, sourceOffset, sourceOrdinal); return; }
    if (packet.LapNumber === this.physicalLap) {
      if (this.deferred.length === 0) { await this.options.feed(packet, sourceOffset, sourceOrdinal); return; }
      this.defer(packet, sourceOffset, sourceOrdinal);
      if (this.nativeTimingRolled(packet)) await this.releaseDeferred(packet.LastLap);
      return;
    }
    if (packet.LapNumber !== this.physicalLap + 1) {
      this.pendingUnexpectedLap = { packet, rawByteOffset: sourceOffset, rawOrdinal: sourceOrdinal };
      return;
    }
    this.physicalLap = packet.LapNumber;
    if (this.skipFirstCompletion) {
      this.skipFirstCompletion = false;
      await this.options.feed({ ...packet, LastLap: 0 }, sourceOffset, sourceOrdinal);
      return;
    }
    if (this.deferred.length > 0) throw new Error("iRacing deferred packet window crossed another lap before native timing resolved; capture stopped to prevent frame loss");
    this.staleLastLap = packet.LastLap; this.peakNativeCurrentLap = 0;
    this.defer(packet, sourceOffset, sourceOrdinal);
  }
  async flushStaleLap(): Promise<void> {
    if (this.deferred.length > 0) {
      if (this.options.now() - this.lastActivePacketTime < 10_000) return;
      await this.finalizeCurrentSession(); return;
    }
    await this.options.flushStaleLap();
  }
  async flushIncompleteLap(): Promise<void> {
    if (this.deferred.length === 0) return;
    const authoritativeLastLap = this.deferred[0]?.packet.LastLap;
    if (authoritativeLastLap !== undefined && authoritativeLastLap > 0) {
      await this.releaseDeferred(authoritativeLastLap);
      return;
    }
    await this.releaseDeferredIncomplete();
  }
  async finalizeCurrentSession(): Promise<void> {
    await this.releaseDeferredIncomplete();
    if (this.pendingUnexpectedLap) {
      this.abandonUnexpected(this.pendingUnexpectedLap);
      this.pendingUnexpectedLap = null;
    }
    this.sessionKey = undefined;
    this.physicalLap = null; this.skipFirstCompletion = true; this.staleLastLap = 0;
    this.peakNativeCurrentLap = 0; this.lastActivePacketTime = 0;
    await this.options.finalizeCurrentSession();
  }
  private resetGate(packet: TelemetryPacket): void {
    this.sessionKey = packet.sessionUID; this.physicalLap = packet.LapNumber;
    this.skipFirstCompletion = !this.completeInitialLapExpected; this.completeInitialLapExpected = false;
    this.pendingUnexpectedLap = null; this.staleLastLap = packet.LastLap;
    this.peakNativeCurrentLap = packet.iracing?.sdkCurrentLapTime ?? 0;
  }
  private defer(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): void {
    if (this.deferred.length >= MAX_DEFERRED_PACKETS) {
      throw new Error(`iRacing deferred packet retention exceeded ${MAX_DEFERRED_PACKETS} packets; capture stopped to prevent source-frame loss`);
    }
    const first = this.deferred.length === 0;
    this.deferred.push({ packet, rawByteOffset, rawOrdinal });
    this.peakNativeCurrentLap = Math.max(this.peakNativeCurrentLap, packet.iracing?.sdkCurrentLapTime ?? 0);
    this.publishOwnership(first ? "window-start" : "snapshot", first ? this.deferredOwnershipWindow("provisional") : null);
  }
  private deferredOwnershipWindow(status: DetectorOwnershipWindow["status"]): DetectorOwnershipWindow {
    const first = this.deferred[0];
    const frameCount = first?.rawOrdinal !== undefined && this.currentRawOrdinal !== null
      ? Math.max(0, this.currentRawOrdinal - first.rawOrdinal + 1)
      : this.deferred.reduce((count, entry) => count + (entry.rawByteOffset === undefined ? 0 : 1), 0);
    return Object.freeze({
      revision: this.ownershipRevision + 1, lapNumber: first?.packet.LapNumber ?? 0,
      startOffset: first?.rawByteOffset ?? null, startOrdinal: first?.rawOrdinal ?? null,
      frameCount, status, trailingContextFrameCount: 0, bounded: true,
    });
  }
  private nativeTimingRolled(packet: TelemetryPacket): boolean {
    const lastLapChanged = packet.LastLap > 0 && Math.abs(packet.LastLap - this.staleLastLap) > 0.000_1;
    const current = packet.iracing?.sdkCurrentLapTime;
    const timerReset = current !== undefined && this.peakNativeCurrentLap > 10 && current < Math.min(5, this.peakNativeCurrentLap * 0.5);
    return lastLapChanged || timerReset;
  }
  private async releaseDeferred(lapTime: number): Promise<void> {
    const [boundary, ...rest] = this.deferred; this.deferred = [];
    if (!boundary) return;
    this.publishOwnership("snapshot", null);
    await this.options.feed({ ...boundary.packet, LastLap: lapTime }, boundary.rawByteOffset, boundary.rawOrdinal);
    for (const entry of rest) await this.options.feed(entry.packet, entry.rawByteOffset, entry.rawOrdinal);
  }
  private async releaseDeferredIncomplete(): Promise<void> {
    if (this.deferred.length === 0) return;
    const window = this.deferredOwnershipWindow("incomplete");
    this.deferred = [];
    if (window.startOffset !== null && window.frameCount > 0) this.publishOwnership("window-abandoned", window);
  }
  private abandonUnexpected(entry: DeferredPacket): void {
    if (entry.rawByteOffset === undefined) return;
    this.publishOwnership("window-abandoned", Object.freeze({
      revision: this.ownershipRevision + 1,
      lapNumber: entry.packet.LapNumber,
      startOffset: entry.rawByteOffset,
      startOrdinal: entry.rawOrdinal ?? null,
      frameCount: 1,
      status: "incomplete",
      trailingContextFrameCount: 0,
      bounded: true,
    }));
  }
  private async acceptUnexpectedLap(entry: DeferredPacket): Promise<void> {
    await this.releaseDeferredIncomplete();
    this.physicalLap = entry.packet.LapNumber; this.skipFirstCompletion = true;
    await this.options.feed(entry.packet, entry.rawByteOffset, entry.rawOrdinal);
  }
}
