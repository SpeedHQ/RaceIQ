import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { detectLapBoundary, detectLapReset, detectSessionBoundary, type LapResetResult } from "./boundaries";

/** Detector-owned source window; end is resolved from start ordinal and count. */
export interface DetectorOwnershipWindow {
  readonly revision: number;
  readonly lapNumber: number;
  readonly startOffset: number | null;
  readonly startOrdinal: number | null;
  readonly frameCount: number;
  readonly status: "provisional" | "final" | "incomplete";
  readonly trailingContextFrameCount: number;
  readonly bounded: true;
  readonly preparationOnly?: true;
  /** Do not release this source record until its delayed boundary is resolved. */
  readonly holdForResolution?: true;
}
export interface DetectorOwnershipState {
  readonly revision: number;
  readonly watermarkOffset: number | null;
  readonly nextWindowStartOffset: number | null;
  readonly windows: readonly DetectorOwnershipWindow[];
}
export interface DetectorOwnershipTransition {
  readonly revision: number;
  readonly kind: "window-start" | "candidate-start" | "window-finalized" | "snapshot" | "final-incomplete" | "window-abandoned" | "reset" | "auxiliary-watermark";
  readonly window: DetectorOwnershipWindow | null;
  readonly state: DetectorOwnershipState;
}
export interface OrdinalSession {
  /** Monotonic processor-local key. Never a database identifier. */
  sessionKey: number;
  carId: string;
  trackId: string;
  gameId: TelemetryPacket["gameId"];
  sessionUID?: string;
}
export interface OrdinalFuelData { lap: number; fuelStart: number; fuelEnd: number; fuelUsed: number }
export interface OrdinalTireWearData {
  lap: number;
  start: { fl: number; fr: number; rl: number; rr: number };
  end: { fl: number; fr: number; rl: number; rr: number };
  worn: { fl: number; fr: number; rl: number; rr: number };
}
export interface OrdinalEngineState {
  session: OrdinalSession | null;
  lapNumber: number;
  lapBuffer: TelemetryPacket[];
  lapIsValid: boolean;
  invalidReason: string | null;
  lastLastLap: number;
  lastTimestampMS: number;
  lastPacketTime: number;
  distanceAtLapStart: number;
  lapByteOffset: number | null;
  currentRawByteOffset: number | null;
  lapFrameCount: number;
  completedLapCount: number;
  fuelAtLapStart: number;
  tireWearAtLapStart: { fl: number; fr: number; rl: number; rr: number };
  fuelHistory: OrdinalFuelData[];
  tireWearHistory: OrdinalTireWearData[];
  currentPitCycleReason: string | null;
  nextPitCycleReason: string | null;
  forzaRaceOffObserved: boolean;
  recentPacketCount: number;
  lastRateCheck: number;
  packetRate: number;
}
export interface OrdinalEngineEffects {
  resolveLapReset?(previous: TelemetryPacket, lastLastLap: number, packet: TelemetryPacket): LapResetResult;
  now(): number;
  createSession(packet: TelemetryPacket): Promise<Omit<OrdinalSession, "sessionKey"> | null>;
  finalizeLap(packet: TelemetryPacket, state: Readonly<OrdinalEngineState>): Promise<boolean>;
  finalizeIncompleteLap(state: Readonly<OrdinalEngineState>): Promise<void>;
  finalizeStaleLap(lapTime: number, isComplete: boolean, silenceMs: number, state: Readonly<OrdinalEngineState>): Promise<void>;
  finalizeSession(session: OrdinalSession): Promise<void>;
  onSessionStarted?(session: OrdinalSession): void | Promise<void>;
  onProvisionalLapResume?(startsNewSession: boolean): Promise<"discard" | "retain" | void> | "discard" | "retain" | void;
  pitTransition?(previous: TelemetryPacket, next: TelemetryPacket, raceOffObserved: boolean): boolean;
  log?(message: string): void;
  ownershipWindow?(window: DetectorOwnershipWindow): void;
}

/** Backend-free ordinal lap/session transition engine. Host effects execute at original await sites. */
export class OrdinalDetectorEngine {
  private sessionSequence = 0;
  readonly state: OrdinalEngineState = {
    session: null, lapNumber: -1, lapBuffer: [], lapIsValid: true,
    invalidReason: null, lastLastLap: 0, lastTimestampMS: 0,
    lastPacketTime: 0, distanceAtLapStart: 0, lapByteOffset: null,
    currentRawByteOffset: null, lapFrameCount: 0, completedLapCount: 0,
    fuelAtLapStart: -1, tireWearAtLapStart: { fl: -1, fr: -1, rl: -1, rr: -1 },
    fuelHistory: [], tireWearHistory: [], currentPitCycleReason: null,
    nextPitCycleReason: null, forzaRaceOffObserved: false,
    recentPacketCount: 0, lastRateCheck: 0, packetRate: 0,
  };
  private bypassPacketRateFilter: boolean;
  private readonly effects: OrdinalEngineEffects;
  private ownershipRevision = 0;
  private ownershipEndOrdinal: number | null = null;
  private ownershipWindows: DetectorOwnershipWindow[] = [];
  private ownershipListeners = new Set<(transition: DetectorOwnershipTransition) => void>();
  private lapFrameOffsets: Array<number | null> = [];
  private lapFrameOrdinals: number[] = [];
  private currentSourceOrdinal: number | null = null;
  private processingSourceOrdinal: number | null = null;
  private processingSourceOffset: number | null = null;
  private lapStartOrdinal: number | null = null;
  private ownershipTrackingEnabled = false;
  private pendingOwnershipTransitions: DetectorOwnershipTransition[] = [];
  private lastInputTelemetry: TelemetryPacket | null = null;
  getOwnershipState(): DetectorOwnershipState {
    const s = this.state;
    return Object.freeze({
      revision: this.ownershipRevision,
      watermarkOffset: s.lapByteOffset,
      nextWindowStartOffset: s.lapByteOffset,
      windows: Object.freeze([...this.ownershipWindows]),
    });
  }
  observeSourceRecord(offset: number, _endOffset: number, ordinal: number): void {
    this.ownershipTrackingEnabled = true;
    this.state.currentRawByteOffset = offset;
    this.currentSourceOrdinal = ordinal;
    if (this.lapStartOrdinal !== null) this.state.lapFrameCount = Math.max(this.state.lapFrameCount, ordinal - this.lapStartOrdinal + 1);
  }
  drainOwnershipTransitions(): DetectorOwnershipTransition[] {
    const transitions = this.pendingOwnershipTransitions;
    this.pendingOwnershipTransitions = [];
    for (const transition of transitions) {
      for (const listener of this.ownershipListeners) listener(transition);
    }
    return transitions;
  }
  subscribeOwnership(listener: (transition: DetectorOwnershipTransition) => void): () => void {
    this.ownershipTrackingEnabled = true;
    this.ownershipListeners.add(listener);
    return () => this.ownershipListeners.delete(listener);
  }
  private publishOwnership(kind: DetectorOwnershipTransition["kind"], window: DetectorOwnershipWindow | null): void {
    if (!this.ownershipTrackingEnabled) return;
    if (this.pendingOwnershipTransitions.length >= 128) throw new Error("Detector ownership transition queue exceeded limit");
    this.ownershipRevision++;
    const published = window && kind !== "snapshot" ? Object.freeze({ ...window, revision: this.ownershipRevision }) : window;
    if (published && kind !== "snapshot" && kind !== "candidate-start") {
      this.ownershipWindows.push(published);
      if (this.ownershipWindows.length > 2) this.ownershipWindows.shift();
    }
    const state = this.getOwnershipState();
    this.pendingOwnershipTransitions.push(Object.freeze({ revision: this.ownershipRevision, kind, window: published, state }));
  }

  constructor(effects: OrdinalEngineEffects, options: { bypassPacketRateFilter?: boolean } = {}) {
    this.effects = effects;
    this.bypassPacketRateFilter = options.bypassPacketRateFilter ?? false;
  }

  setBypassPacketRateFilter(value: boolean): void { this.bypassPacketRateFilter = value; }
  shouldCheckpoint(packet: TelemetryPacket): boolean {
    const s = this.state;
    const previous = s.lapBuffer.at(-1);
    if (!s.session || s.lapNumber < 0) return true;

    const now = this.effects.now();
    if (detectSessionBoundary(
      s.session,
      s.lapNumber,
      previous?.DistanceTraveled ?? null,
      s.lastPacketTime,
      packet,
      now,
    )) return true;

    if (s.lapNumber >= 0 && packet.LapNumber !== s.lapNumber) {
      detectLapBoundary(s.lapNumber, packet);
      return true;
    }
    if (
      s.lapNumber >= 0 &&
      s.lapBuffer.length > 30 &&
      packet.LapNumber === s.lapNumber &&
      previous &&
      detectLapReset(previous, s.lastLastLap, packet).action !== "none"
    ) return true;
    return s.lastTimestampMS > 0 &&
      packet.TimestampMS < s.lastTimestampMS &&
      packet.LapNumber === s.lapNumber;
  }

  setCurrentLapByteOffset(offset: number, rawOrdinal?: number): void {
    this.state.lapByteOffset = offset;
    this.state.currentRawByteOffset = offset;
    if (rawOrdinal !== undefined) {
      this.currentSourceOrdinal = rawOrdinal;
      this.processingSourceOrdinal = rawOrdinal;
      this.processingSourceOffset = offset;
      this.lapStartOrdinal = rawOrdinal;
      this.state.lapFrameCount = 1;
    }
    this.pendingOwnershipTransitions = this.pendingOwnershipTransitions.map((transition) => {
      if (transition.kind !== "window-start" && transition.kind !== "snapshot") return transition;
      const window = transition.window
        ? Object.freeze({ ...transition.window, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, frameCount: 1 }) })
        : null;
      const state = Object.freeze({
        ...transition.state,
        watermarkOffset: offset,
        nextWindowStartOffset: offset,
        windows: Object.freeze(transition.state.windows.map((item) =>
          item.startOrdinal === this.lapStartOrdinal
            ? Object.freeze({ ...item, startOffset: offset, ...(rawOrdinal === undefined ? {} : { startOrdinal: rawOrdinal, frameCount: 1 }) })
            : item,
        )),
      });
      return Object.freeze({ ...transition, window, state });
    });
  }
  markProvisionalSnapshot(): void {
    if (this.state.session?.gameId === "fm-2023") this.state.forzaRaceOffObserved = true;
    this.publishOwnership("snapshot", this.activeWindow("provisional"));
  }
  clampCurrentLapOwnership(endOrdinal: number): void {
    this.ownershipEndOrdinal = this.ownershipEndOrdinal === null
      ? endOrdinal : Math.min(this.ownershipEndOrdinal, endOrdinal);
  }
  private activeWindow(status: DetectorOwnershipWindow["status"], ownedFrameCount?: number): DetectorOwnershipWindow | null {
    const s = this.state;
    const latestOrdinal = this.ownershipEndOrdinal === null
      ? this.currentSourceOrdinal : Math.min(this.currentSourceOrdinal ?? this.ownershipEndOrdinal, this.ownershipEndOrdinal);
    const frameCount = ownedFrameCount ?? (latestOrdinal !== null && this.lapStartOrdinal !== null
      ? latestOrdinal - this.lapStartOrdinal + 1
      : s.lapFrameCount);
    if (s.lapNumber < 0 || s.lapByteOffset === null || frameCount <= 0) return null;
    return { revision: this.ownershipRevision + 1, lapNumber: s.lapNumber, startOffset: s.lapByteOffset, startOrdinal: this.lapStartOrdinal, frameCount, status, trailingContextFrameCount: 0, bounded: true };
  }
  private observeRunningStartCandidate(packet: TelemetryPacket): void {
    const previous = this.lastInputTelemetry;
    if (previous && this.state.session?.gameId === packet.gameId && this.state.lapNumber >= 0 && previous.CurrentLap > 5 && packet.CurrentLap < 1) {
      // Candidate is preparation-only; trimRunningStartPackets remains ownership authority.
      this.publishOwnership("candidate-start", {
        revision: this.ownershipRevision + 1,
        lapNumber: this.state.lapNumber,
        startOffset: this.state.currentRawByteOffset,
        startOrdinal: this.currentSourceOrdinal,
        frameCount: 0,
        status: "provisional",
        trailingContextFrameCount: 0,
        bounded: true,
        preparationOnly: true,
      });
    }
    this.lastInputTelemetry = packet;
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void> {
    const s = this.state;
    if (rawOrdinal !== undefined) {
      this.currentSourceOrdinal = rawOrdinal;
      this.processingSourceOrdinal = rawOrdinal;
    }
    if (rawByteOffset !== undefined) this.processingSourceOffset = rawByteOffset;
    s.currentRawByteOffset = rawByteOffset ?? s.currentRawByteOffset;
    this.observeRunningStartCandidate(packet);
    const now = this.effects.now();
    s.recentPacketCount++;
    if (now - s.lastRateCheck >= 1000) {
      s.packetRate = s.recentPacketCount;
      s.recentPacketCount = 0;
      s.lastRateCheck = now;
    }
    if (!this.bypassPacketRateFilter && s.session && s.packetRate > 0 && s.packetRate < 30) {
      s.lastPacketTime = now;
      return;
    }
    const previous = s.lapBuffer.at(-1);
    const reason = detectSessionBoundary(s.session, s.lapNumber, previous?.DistanceTraveled ?? null, s.lastPacketTime, packet, now);
    const startsNewSession = !(reason === "silence-timeout" && packet.gameId === "fm-2023") && reason !== null;
    if (reason) this.effects.log?.(`[Session] New session: ${reason}`);
    if (!startsNewSession && previous && s.session?.gameId === "fm-2023" && this.effects.pitTransition?.(previous, packet, s.forzaRaceOffObserved)) {
      s.currentPitCycleReason = mergePitCycleReason(s.currentPitCycleReason, "inlap");
      s.nextPitCycleReason = mergePitCycleReason(s.nextPitCycleReason, "outlap");
      this.effects.log?.(`[Lap] FM pit transition`);
    }
    s.forzaRaceOffObserved = false;
    const provisional = await this.effects.onProvisionalLapResume?.(startsNewSession);
    if (startsNewSession) {
      if (provisional === "discard") this.discardIncompleteLap();
      if (s.session) await this.finalizeIncompleteLap();
      const identity = await this.effects.createSession(packet);
      if (identity) {
        s.lapNumber = -1; s.lapBuffer = []; s.lapIsValid = true; s.invalidReason = null;
        s.session = { ...identity, sessionKey: ++this.sessionSequence, gameId: packet.gameId };
        s.completedLapCount = 0; s.lastTimestampMS = 0; s.distanceAtLapStart = packet.DistanceTraveled;
        s.lapByteOffset = null; s.lapFrameCount = 0; this.lapStartOrdinal = null; this.lapFrameOrdinals = [];
        this.ownershipEndOrdinal = null;
        s.fuelAtLapStart = packet.Fuel; s.tireWearAtLapStart = tireWear(packet);
        s.currentPitCycleReason = null; s.nextPitCycleReason = null; s.forzaRaceOffObserved = false;
        await this.effects.onSessionStarted?.(s.session);
      }
    }
    if (!s.session) return;
    if (s.lapNumber >= 0 && s.lapBuffer.length > 30 && packet.LapNumber === s.lapNumber) {
      const reset = (this.effects.resolveLapReset ?? detectLapReset)(s.lapBuffer[s.lapBuffer.length - 1], s.lastLastLap, packet);
      if (reset.action === "complete-final-lap") {
        this.effects.log?.(`[Lap] Final lap completed: LastLap ${s.lastLastLap.toFixed(3)} -> ${packet.LastLap.toFixed(3)}`);
        await this.complete(packet);
      } else if (reset.action === "reset-untimed-lap") {
        this.effects.log?.("[Lap] Untimed start-line crossing — starting lap buffer");
        this.reset(packet);
      } else if (reset.action === "reset-restart") {
        this.reset(packet, true);
      }
    }
    if (s.lastTimestampMS > 0 && packet.TimestampMS < s.lastTimestampMS && packet.LapNumber === s.lapNumber) {
      this.effects.log?.(`[Lap] Rewind: timestamp ${s.lastTimestampMS} -> ${packet.TimestampMS}. Marking lap invalid.`);
      this.invalidate("rewind");
    }
    if (s.lapNumber >= 0 && packet.LapNumber !== s.lapNumber) {
      const boundary = detectLapBoundary(s.lapNumber, packet);
      if (boundary.action === "reset-rewind") {
        this.reset(packet, true);
      } else {
        if (boundary.action === "complete-skip") { this.effects.log?.(`[Lap] Lap skip: ${s.lapNumber} -> ${packet.LapNumber}. Marking invalid.`); this.invalidate(boundary.invalidReason); }
        await this.complete(packet);
      }
    }
    s.lastLastLap = packet.LastLap;
    if (s.lapNumber < 0) {
      s.lapNumber = packet.LapNumber; s.distanceAtLapStart = packet.DistanceTraveled;
      s.lapByteOffset = this.processingSourceOffset ?? s.currentRawByteOffset;
      s.lapFrameCount = 0;
      this.lapStartOrdinal = this.processingSourceOrdinal ?? this.currentSourceOrdinal;
    }
    s.lapBuffer.push(packet); this.lapFrameOffsets.push(this.processingSourceOffset ?? s.currentRawByteOffset);
    this.lapFrameOrdinals.push(this.processingSourceOrdinal ?? this.currentSourceOrdinal ?? 0);
    s.lapFrameCount = this.processingSourceOrdinal !== null && this.lapStartOrdinal !== null
      ? this.processingSourceOrdinal - this.lapStartOrdinal + 1
      : s.lapFrameCount + 1;
    s.lastTimestampMS = packet.TimestampMS; s.lastPacketTime = now;
    if (s.lapFrameCount === 1) this.publishOwnership("window-start", this.activeWindow("provisional"));
  }

  async flushIncompleteLap(): Promise<void> {
    await this.finalizeIncompleteLap();
    this.discardIncompleteLap();
  }

  async finalizeIncompleteLap(): Promise<void> {
    this.processingSourceOrdinal = this.currentSourceOrdinal;
    const s = this.state;
    this.trimRunningStartPackets(true);
    const window = this.activeWindow("incomplete");
    if (window) s.lapFrameCount = window.frameCount;
    if (s.lapBuffer.length && s.lapBuffer[s.lapBuffer.length - 1].CurrentLap >= 10) {
      await this.effects.finalizeIncompleteLap(s);
      this.publishOwnership("final-incomplete", window);
    } else {
      this.publishOwnership("window-abandoned", window);
    }
  }
  finalizeRetainedIncompleteOwnership(): void {
    this.processingSourceOrdinal = this.currentSourceOrdinal;
    this.publishOwnership("final-incomplete", this.activeWindow("incomplete"));
  }

  discardIncompleteLap(): void {
    this.state.lapBuffer = [];
    this.state.lapNumber = -1;
    this.state.lastPacketTime = 0;
    this.ownershipEndOrdinal = null;
  }

  async flushStaleLap(): Promise<void> {
    const s = this.state;
    if (!s.session || s.lapBuffer.length < 30 || s.lapNumber < 0 || !s.lastPacketTime || s.session.gameId === "fm-2023") return;
    const silenceMs = this.effects.now() - s.lastPacketTime;
    if (silenceMs < 10_000) return;
    this.trimRunningStartPackets(true);
    if (s.lapBuffer.length < 30) return;
    const last = s.lapBuffer[s.lapBuffer.length - 1];
    const isComplete = last.LastLap > 0 && last.LastLap !== s.lastLastLap;
    const lapTime = isComplete ? last.LastLap : last.CurrentLap;
    if (lapTime < 10) return;
    await this.effects.finalizeStaleLap(lapTime, isComplete, silenceMs, s);
    this.publishOwnership(isComplete ? "window-finalized" : "final-incomplete", this.activeWindow(isComplete ? "final" : "incomplete"));
    this.discardIncompleteLap();
  }

  private async complete(next: TelemetryPacket): Promise<void> {
    const s = this.state;
    if (!s.session || !s.lapBuffer.length) { this.reset(next); return; }
    const last = s.lapBuffer[s.lapBuffer.length - 1];
    if (s.fuelAtLapStart >= 0) { s.fuelHistory.push({ lap:s.lapNumber, fuelStart:s.fuelAtLapStart, fuelEnd:last.Fuel, fuelUsed:s.fuelAtLapStart-last.Fuel }); if(s.fuelHistory.length>50)s.fuelHistory.shift(); }
    if (s.tireWearAtLapStart.fl >= 0) { const end=tireWear(last), start=s.tireWearAtLapStart; s.tireWearHistory.push({lap:s.lapNumber,start:{...start},end,worn:{fl:start.fl-end.fl,fr:start.fr-end.fr,rl:start.rl-end.rl,rr:start.rr-end.rr}}); if(s.tireWearHistory.length>50)s.tireWearHistory.shift(); }
    const boundaryOrdinal = this.ownershipEndOrdinal === null
      ? this.processingSourceOrdinal ?? this.currentSourceOrdinal
      : Math.min(this.processingSourceOrdinal ?? this.currentSourceOrdinal ?? this.ownershipEndOrdinal + 1, this.ownershipEndOrdinal + 1);
    const ownedFrameCount = boundaryOrdinal !== null && this.lapStartOrdinal !== null
      ? boundaryOrdinal - this.lapStartOrdinal
      : s.lapFrameCount;
    s.lapFrameCount = ownedFrameCount;
    const saved = await this.effects.finalizeLap(next, s);
    if (saved) {
      s.completedLapCount++;
      this.publishOwnership("window-finalized", this.activeWindow("final", s.lapFrameCount));
    } else {
      this.publishOwnership("window-abandoned", this.activeWindow("incomplete", s.lapFrameCount));
    }
    this.reset(next);
  }

  reset(packet: TelemetryPacket, abandonCurrent = false): void {
    const s = this.state;
    if (abandonCurrent && s.lapBuffer.length > 0) {
      this.publishOwnership("window-abandoned", this.activeWindow("incomplete", Math.max(0, s.lapFrameCount - 1)));
    }
    s.lapNumber=packet.LapNumber; s.lapBuffer=[]; this.lapFrameOffsets=[]; this.lapFrameOrdinals=[]; s.lapIsValid=true; s.invalidReason=null;
    s.currentPitCycleReason=s.nextPitCycleReason; s.nextPitCycleReason=null; s.lastLastLap=packet.LastLap;
    s.distanceAtLapStart=packet.DistanceTraveled; s.lapByteOffset=this.processingSourceOffset ?? s.currentRawByteOffset; s.lapFrameCount=0;
    this.lapStartOrdinal = this.processingSourceOrdinal ?? this.currentSourceOrdinal;
    this.ownershipEndOrdinal = null;
    s.fuelAtLapStart=packet.Fuel; s.tireWearAtLapStart=tireWear(packet);
    this.publishOwnership("auxiliary-watermark", null);
  }
  invalidate(reason: string): void { this.state.lapIsValid=false; this.state.invalidReason=reason; }
  trimRunningStartPackets(_includeCurrentRecord = false): void {
    const p=this.state.lapBuffer;
    const start=runningStartPacketIndex(p);
    if(start>0) {
      this.effects.log?.(`[Lap] Trimmed ${start} pre-start packets (running start), ${p.length - start} remain`);
      // Keep source ownership anchored to the original lap start. Capture consumers
      // use the byte range/count to preserve every raw record, including trimmed packets.
      p.copyWithin(0, start);
      p.length -= start;
      this.lapFrameOffsets.splice(0, start);
      this.lapFrameOrdinals.splice(0, start);
    }
  }

  async finalizeCurrentSession(): Promise<void> {
    const s=this.state; if(!s.session)return;
    await this.effects.finalizeSession(s.session); s.session=null;
  }
}

export function runningStartPacketIndex(packets: readonly TelemetryPacket[]): number {
  let start = 0;
  for (let index = 1; index < packets.length; index++) {
    if (packets[index - 1]!.CurrentLap > 5 && packets[index]!.CurrentLap < 1) {
      start = index;
    }
  }
  return start > 0 && start < packets.length / 2 ? start : 0;
}

function tireWear(packet: TelemetryPacket): { fl: number; fr: number; rl: number; rr: number } {
  return { fl: packet.TireWearFL, fr: packet.TireWearFR, rl: packet.TireWearRL, rr: packet.TireWearRR };
}
function mergePitCycleReason(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next || current === next) return current;
  return "pit lap";
}
