import type { AccBroadcastCar, AccBroadcastEntry, AccBroadcastExtension, AccBroadcastMessage, AccBroadcastSnapshot, AccBroadcastSourceReason } from "../../../shared/telemetry/acc-broadcast";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { AccBroadcastCaptureEvent } from "./broadcast-capture";

const SESSION_TYPE: Record<number, string> = { 0: "practice", 4: "qualifying", 9: "superpole", 10: "race", 11: "hotlap", 12: "hotstint", 13: "hotlap_superpole", 14: "replay" };
const LOCATION: Record<number, string> = { 1: "track", 2: "pit_lane", 3: "pit_entry", 4: "pit_exit" };
const location = (value: number): string => LOCATION[value] ?? "unknown";
const validCarIndex = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffff;
const validDriverIndex = (value: number, count: number): boolean => Number.isInteger(value) && value >= 0 && value < count;

export class AccBroadcastState {
  private eventIndex = -1;
  private sessionIndex = -1;
  private sessionTypeValue = "unknown";
  private phaseValue = 0;
  private playerCarIndex = -1;
  private connected = false;
  private registered = false;
  private malformedReason: AccBroadcastSourceReason | null = null;
  private lastRealtimeAt = -Infinity;
  private membership: Set<number> | null = null;
  private readonly entries = new Map<number, AccBroadcastEntry>();
  private readonly cars = new Map<number, AccBroadcastCar>();
  private readonly carUpdatedAt = new Map<number, number>();
  private readonly rawEvidence = new Map<string, AccBroadcastCaptureEvent>();
  private malformedPrerequisites: readonly AccBroadcastCaptureEvent[] = [];
  private readonly now: () => number;
  private readonly competitorStaleMs: number;

  constructor(options: { now?: () => number; competitorStaleMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.competitorStaleMs = options.competitorStaleMs ?? 1_000;
  }

  setSocketConnected(value: boolean, evidence?: AccBroadcastCaptureEvent): void {
    if (!value || !this.connected) {
      this.clearEvidence();
      this.registered = false;
      this.rawEvidence.delete("registration");
    }
    this.connected = value;
    if (evidence) this.rawEvidence.set("socket", evidence);
  }

  setRegistered(value: boolean, evidence?: AccBroadcastCaptureEvent): void {
    this.registered = value;
    if (!value) {
      this.clearEvidence();
    }
    if (evidence) this.rawEvidence.set("registration", evidence);
  }

  markMalformed(reason: AccBroadcastSourceReason = "malformed-datagram", evidence?: AccBroadcastCaptureEvent): void {
    // Joined validation failures need their earlier raw facts to fail the same
    // way in a new recording (for example, driver index versus entry identity).
    this.malformedPrerequisites = evidence
      ? [...this.rawEvidence].filter(([key]) => key !== "socket" && key !== "registration" && key !== "malformed").map(([, event]) => event)
      : [];
    this.clearEvidence();
    this.malformedReason = reason;
    if (evidence) this.rawEvidence.set("malformed", evidence);
  }

  apply(message: AccBroadcastMessage, receivedAt = this.now(), evidence?: AccBroadcastCaptureEvent): void {
    if (message.type === "registration-result") {
      this.setRegistered(message.success, evidence);
      return;
    }
    if (message.type === "realtime-update") {
      if (this.sessionIndex >= 0 && (this.sessionIndex !== message.sessionIndex || this.eventIndex !== message.eventIndex)) this.clearEvidence();
      this.eventIndex = message.eventIndex;
      this.sessionIndex = message.sessionIndex;
      this.sessionTypeValue = SESSION_TYPE[message.sessionType] ?? "unknown";
      this.phaseValue = message.phase;
      this.lastRealtimeAt = receivedAt;
      this.setPlayerCarIndex(message.focusedCarIndex);
      if (evidence) this.rawEvidence.set("session", evidence);
      return;
    }
    if (message.type === "entry-list") {
      if (message.carIndexes.length > 64) { this.markMalformed("too-many-competitors", evidence); return; }
      const allowed = new Set(message.carIndexes);
      if (allowed.size !== message.carIndexes.length || message.carIndexes.some((index) => !validCarIndex(index))) {
        this.markMalformed("duplicate-car-index", evidence); return;
      }
      this.membership = allowed;
      if (evidence) this.rawEvidence.set("membership", evidence);
      for (const carIndex of this.entries.keys()) if (!allowed.has(carIndex)) {
        this.entries.delete(carIndex);
        this.rawEvidence.delete(`entry:${carIndex}`);
      }
      for (const carIndex of this.cars.keys()) if (!allowed.has(carIndex)) {
        this.cars.delete(carIndex);
        this.carUpdatedAt.delete(carIndex);
        this.rawEvidence.delete(`car:${carIndex}`);
      }
      return;
    }
    if (message.type !== "entry-list-car" && message.type !== "realtime-car-update") return;
    if (!validCarIndex(message.carIndex)) { this.markMalformed("malformed-datagram", evidence); return; }
    if (this.membership && !this.membership.has(message.carIndex)) return;
    if (message.type === "entry-list-car") {
      const car = this.cars.get(message.carIndex);
      if (!validDriverIndex(message.currentDriverIndex, message.drivers.length) || (car && !validDriverIndex(car.driverIndex, message.drivers.length))) {
        this.markMalformed("invalid-driver-index", evidence); return;
      }
      if (!this.entries.has(message.carIndex) && this.entries.size >= 64) { this.markMalformed("too-many-competitors", evidence); return; }
      this.entries.set(message.carIndex, message);
      if (evidence) this.rawEvidence.set(`entry:${message.carIndex}`, evidence);
    } else {
      const entry = this.entries.get(message.carIndex);
      if (!validDriverIndex(message.driverIndex, message.driverCount) || (entry && !validDriverIndex(message.driverIndex, entry.drivers.length))) {
        this.markMalformed("invalid-driver-index", evidence); return;
      }
      if (!this.cars.has(message.carIndex) && this.cars.size >= 64) { this.markMalformed("too-many-competitors", evidence); return; }
      this.cars.set(message.carIndex, message);
      this.carUpdatedAt.set(message.carIndex, receivedAt);
      if (evidence) this.rawEvidence.set(`car:${message.carIndex}`, evidence);
    }
  }

  hasEntry(carIndex: number): boolean { return this.entries.has(carIndex); }
  needsEntryList(): boolean {
    if (this.malformedReason || !this.membership) return true;
    for (const index of this.membership) if (!this.entries.has(index)) return true;
    return false;
  }
  setPlayerCarIndex(carIndex: number): void { this.playerCarIndex = validCarIndex(carIndex) ? carIndex : -1; }
  reset(evidence?: AccBroadcastCaptureEvent): void {
    this.clearEvidence();
    this.connected = false;
    this.registered = false;
    this.malformedReason = null;
    this.rawEvidence.clear();
    this.malformedPrerequisites = [];
    if (evidence) this.rawEvidence.set("socket", evidence);
  }

  sourceStatus(now = this.now()): AccBroadcastSnapshot["source"] {
    let complete = this.membership !== null && this.membership.size > 0 && this.membership.has(this.playerCarIndex);
    if (complete) for (const index of this.membership!) {
      if (!this.entries.has(index) || !this.cars.has(index)) { complete = false; break; }
    }
    if (this.malformedReason) {
      // Recovery must use only complete evidence received after the malformed generation.
      let recovered = this.connected && this.registered && this.sessionIndex >= 0 && complete
        && now - this.lastRealtimeAt <= this.competitorStaleMs;
      if (recovered) for (const at of this.carUpdatedAt.values()) {
        if (now - at > this.competitorStaleMs) { recovered = false; break; }
      }
      if (!recovered) return { state: "malformed", reasonCode: this.malformedReason };
      this.malformedReason = null;
      this.rawEvidence.delete("malformed");
      this.malformedPrerequisites = [];
    }
    if (!this.connected) return { state: "unavailable", reasonCode: "not-connected" };
    if (!this.registered) return { state: "unavailable", reasonCode: "not-registered" };
    if (this.sessionIndex < 0) return { state: "unavailable", reasonCode: "no-session" };
    if (now - this.lastRealtimeAt > this.competitorStaleMs) return { state: "stale", reasonCode: "source-timeout" };
    if (!complete) return { state: "unavailable", reasonCode: "incomplete-grid" };
    return { state: "available", reasonCode: "ready" };
  }

  captureContext(): readonly AccBroadcastCaptureEvent[] {
    return [...this.malformedPrerequisites, ...this.rawEvidence.values()].sort((a, b) => a.sequence - b.sequence);
  }

  snapshot(): AccBroadcastSnapshot {
    const now = this.now();
    const source = this.sourceStatus(now);
    if (source.state !== "available") return { source };
    const rows = [...this.membership!].sort((a, b) => a - b).map((index) => ({ car: this.cars.get(index)!, entry: this.entries.get(index)! }));
    const extension: AccBroadcastExtension = {
      sessionIndex: this.sessionIndex,
      sessionType: this.sessionTypeValue,
      phase: this.phaseValue,
      playerCarIndex: this.playerCarIndex,
      playerCarClassId: String(this.entries.get(this.playerCarIndex)!.cupCategory),
      carIndex: rows.map(({ car }) => car.carIndex),
      driverId: rows.map(({ car }) => `${car.carIndex}:${car.driverIndex}`),
      driverName: rows.map(({ entry, car }) => `${entry.drivers[car.driverIndex]!.firstName} ${entry.drivers[car.driverIndex]!.lastName}`.trim()),
      carClassId: rows.map(({ entry }) => String(entry.cupCategory)),
      carClassName: rows.map(({ entry }) => String(entry.cupCategory)),
      lapsComplete: rows.map(({ car }) => car.laps),
      position: rows.map(({ car }) => car.position),
      pitStatus: rows.map(({ car }) => location(car.location) === "track" ? "out" : location(car.location)),
      trackLocation: rows.map(({ car }) => location(car.location)),
      positionX: rows.map(({ car }) => car.worldPosX),
      positionY: rows.map(() => 0),
      positionZ: rows.map(({ car }) => car.worldPosY),
      speed: rows.map(({ car }) => car.kmh / 3.6),
      yaw: rows.map(({ car }) => car.yaw),
      lastLapTime: rows.map(({ car }) => car.lastLapTimeMs === null ? 0 : car.lastLapTimeMs / 1000),
      lastLapValid: rows.map(({ car }) => car.lastLapValid),
      connected: rows.map(({ car }) => now - this.carUpdatedAt.get(car.carIndex)! <= this.competitorStaleMs),
    };
    return { source, extension };
  }

  private clearEvidence(): void {
    this.eventIndex = -1;
    this.sessionIndex = -1;
    this.sessionTypeValue = "unknown";
    this.phaseValue = 0;
    this.lastRealtimeAt = -Infinity;
    this.membership = null;
    this.entries.clear();
    this.cars.clear();
    this.carUpdatedAt.clear();
    this.playerCarIndex = -1;
    for (const key of this.rawEvidence.keys()) {
      if (key !== "socket" && key !== "registration" && key !== "malformed") this.rawEvidence.delete(key);
    }
  }
}

export function attachAccBroadcastSnapshot(packet: TelemetryPacket, playerCarIndex: number, snapshot: AccBroadcastSnapshot): void {
  if (!packet.acc) return;
  const broadcast = snapshot.source.state === "available" && snapshot.extension?.playerCarIndex === playerCarIndex ? snapshot.extension : undefined;
  packet.acc.broadcastSource = { source: "acc-broadcast", ...snapshot.source };
  Object.assign(packet.acc, {
    broadcastSessionIndex: broadcast?.sessionIndex,
    broadcastSessionType: broadcast?.sessionType,
    broadcastPhase: broadcast?.phase,
    broadcastPlayerCarIndex: broadcast?.playerCarIndex,
    broadcastPlayerCarClassId: broadcast?.playerCarClassId,
    broadcastCarIndex: broadcast?.carIndex,
    broadcastDriverId: broadcast?.driverId,
    broadcastDriverName: broadcast?.driverName,
    broadcastCarClassId: broadcast?.carClassId,
    broadcastCarClassName: broadcast?.carClassName,
    broadcastLapsComplete: broadcast?.lapsComplete,
    broadcastPosition: broadcast?.position,
    broadcastPitStatus: broadcast?.pitStatus,
    broadcastTrackLocation: broadcast?.trackLocation,
    broadcastPositionX: broadcast?.positionX,
    broadcastPositionY: broadcast?.positionY,
    broadcastPositionZ: broadcast?.positionZ,
    broadcastSpeed: broadcast?.speed,
    broadcastYaw: broadcast?.yaw,
    broadcastLastLapTime: broadcast?.lastLapTime,
    broadcastLastLapValid: broadcast?.lastLapValid,
    broadcastConnected: broadcast?.connected,
  });
}

export const accBroadcastState = new AccBroadcastState();