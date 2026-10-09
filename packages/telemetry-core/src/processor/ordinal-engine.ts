import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { detectLapBoundary, detectLapReset, detectSessionBoundary } from "./boundaries";

export interface OrdinalSession {
  /** Monotonic processor-local key. Never a database identifier. */
  sessionKey: number;
  carOrdinal: number;
  trackOrdinal: number;
  gameId: TelemetryPacket["gameId"];
  sessionUID?: string;
  carId?: string;
  trackId?: string;
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

  constructor(effects: OrdinalEngineEffects, options: { bypassPacketRateFilter?: boolean } = {}) {
    this.effects = effects;
    this.bypassPacketRateFilter = options.bypassPacketRateFilter ?? false;
  }

  setBypassPacketRateFilter(value: boolean): void { this.bypassPacketRateFilter = value; }
  setCurrentLapByteOffset(offset: number): void {
    this.state.lapByteOffset = offset;
    this.state.currentRawByteOffset = offset;
  }
  markProvisionalSnapshot(): void {
    if (this.state.session?.gameId === "fm-2023") this.state.forzaRaceOffObserved = true;
  }

  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    const s = this.state;
    s.currentRawByteOffset = rawByteOffset ?? null;
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
        s.session = { ...identity, sessionKey: ++this.sessionSequence, gameId: packet.gameId };
        s.lapNumber = -1; s.lapBuffer = []; s.lapIsValid = true; s.invalidReason = null;
        s.completedLapCount = 0; s.lastTimestampMS = 0; s.distanceAtLapStart = packet.DistanceTraveled;
        s.lapByteOffset = null; s.lapFrameCount = 0;
        s.currentPitCycleReason = null; s.nextPitCycleReason = null; s.forzaRaceOffObserved = false;
        await this.effects.onSessionStarted?.(s.session);
      }
    }
    if (!s.session) return;
    if (s.lapNumber >= 0 && s.lapBuffer.length > 30 && packet.LapNumber === s.lapNumber) {
      const reset = detectLapReset(s.lapBuffer[s.lapBuffer.length - 1], s.lastLastLap, packet);
      if (reset.action === "complete-final-lap") {
        this.effects.log?.(`[Lap] Final lap completed: LastLap ${s.lastLastLap.toFixed(3)} -> ${packet.LastLap.toFixed(3)}`);
        await this.complete(packet);
      } else if (reset.action === "reset-restart") {
        this.effects.log?.("[Lap] Race restart detected — discarding buffer");
        this.reset(packet);
      }
    }
    if (s.lastTimestampMS > 0 && packet.TimestampMS < s.lastTimestampMS && packet.LapNumber === s.lapNumber) {
      this.effects.log?.(`[Lap] Rewind: timestamp ${s.lastTimestampMS} -> ${packet.TimestampMS}. Marking lap invalid.`);
      this.invalidate("rewind");
    }
    if (s.lapNumber >= 0 && packet.LapNumber !== s.lapNumber) {
      const boundary = detectLapBoundary(s.lapNumber, packet);
      if (boundary.action === "reset-rewind") {
        this.effects.log?.(`[Lap] Rewind across lap boundary: ${s.lapNumber} -> ${packet.LapNumber}. Discarding buffer.`);
        this.reset(packet);
      } else {
        if (boundary.action === "complete-skip") { this.effects.log?.(`[Lap] Lap skip: ${s.lapNumber} -> ${packet.LapNumber}. Marking invalid.`); this.invalidate(boundary.invalidReason); }
        await this.complete(packet);
      }
    }
    s.lastLastLap = packet.LastLap;
    if (s.lapNumber < 0) {
      s.lapNumber = packet.LapNumber; s.distanceAtLapStart = packet.DistanceTraveled;
      s.lapByteOffset = s.currentRawByteOffset; s.lapFrameCount = 0;
      s.fuelAtLapStart = packet.Fuel; s.tireWearAtLapStart = tireWear(packet);
    }
    s.lapBuffer.push(packet); s.lapFrameCount++; s.lastTimestampMS = packet.TimestampMS; s.lastPacketTime = now;
  }

  async flushIncompleteLap(): Promise<void> {
    await this.finalizeIncompleteLap();
    this.discardIncompleteLap();
  }

  async finalizeIncompleteLap(): Promise<void> {
    const s = this.state;
    if (!s.lapBuffer.length || s.lapNumber < 0) return;
    this.trimRunningStartPackets();
    if (s.lapBuffer.length && s.lapBuffer[s.lapBuffer.length - 1].CurrentLap >= 10) {
      await this.effects.finalizeIncompleteLap(s);
    }
  }

  discardIncompleteLap(): void {
    this.state.lapBuffer = [];
    this.state.lapNumber = -1;
    this.state.lastPacketTime = 0;
  }

  async flushStaleLap(): Promise<void> {
    const s = this.state;
    if (!s.session || s.lapBuffer.length < 30 || s.lapNumber < 0 || !s.lastPacketTime || s.session.gameId === "fm-2023") return;
    const silenceMs = this.effects.now() - s.lastPacketTime;
    if (silenceMs < 10_000) return;
    this.trimRunningStartPackets();
    if (s.lapBuffer.length < 30) return;
    const last = s.lapBuffer[s.lapBuffer.length - 1];
    const isComplete = last.LastLap > 0 && last.LastLap !== s.lastLastLap;
    const lapTime = isComplete ? last.LastLap : last.CurrentLap;
    if (lapTime < 10) return;
    await this.effects.finalizeStaleLap(lapTime, isComplete, silenceMs, s);
    this.discardIncompleteLap();
  }

  private async complete(next: TelemetryPacket): Promise<void> {
    const s = this.state;
    if (!s.session || !s.lapBuffer.length) { this.reset(next); return; }
    const last = s.lapBuffer[s.lapBuffer.length - 1];
    if (s.fuelAtLapStart >= 0) { s.fuelHistory.push({ lap:s.lapNumber, fuelStart:s.fuelAtLapStart, fuelEnd:last.Fuel, fuelUsed:s.fuelAtLapStart-last.Fuel }); if(s.fuelHistory.length>50)s.fuelHistory.shift(); }
    if (s.tireWearAtLapStart.fl >= 0) { const end=tireWear(last), start=s.tireWearAtLapStart; s.tireWearHistory.push({lap:s.lapNumber,start:{...start},end,worn:{fl:start.fl-end.fl,fr:start.fr-end.fr,rl:start.rl-end.rl,rr:start.rr-end.rr}}); if(s.tireWearHistory.length>50)s.tireWearHistory.shift(); }
    if (await this.effects.finalizeLap(next, s)) s.completedLapCount++;
    this.reset(next);
  }

  reset(packet: TelemetryPacket): void {
    const s=this.state;
    s.lapNumber=packet.LapNumber; s.lapBuffer=[]; s.lapIsValid=true; s.invalidReason=null;
    s.currentPitCycleReason=s.nextPitCycleReason; s.nextPitCycleReason=null; s.lastLastLap=packet.LastLap;
    s.distanceAtLapStart=packet.DistanceTraveled; s.lapByteOffset=s.currentRawByteOffset; s.lapFrameCount=0;
    s.fuelAtLapStart=packet.Fuel; s.tireWearAtLapStart=tireWear(packet);
  }
  invalidate(reason: string): void { this.state.lapIsValid=false; this.state.invalidReason=reason; }
  trimRunningStartPackets(): void {
    const p=this.state.lapBuffer; if(p.length<=1)return; let i=0;
    for(let n=1;n<p.length;n++) if(p[n-1].CurrentLap>5&&p[n].CurrentLap<1)i=n;
    if(i>0&&i<p.length/2) {
      this.effects.log?.(`[Lap] Trimmed ${i} pre-start packets (running start), ${p.length - i} remain`);
      this.state.lapBuffer=p.slice(i);
    }
  }
  async finalizeCurrentSession(): Promise<void> {
    const s=this.state; if(!s.session)return;
    await this.effects.finalizeSession(s.session); s.session=null;
  }
}

function tireWear(packet: TelemetryPacket): { fl: number; fr: number; rl: number; rr: number } {
  return { fl: packet.TireWearFL, fr: packet.TireWearFR, rl: packet.TireWearRL, rr: packet.TireWearRR };
}
function mergePitCycleReason(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next || current === next) return current;
  return "pit lap";
}
