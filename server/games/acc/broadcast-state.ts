import type { AccBroadcastCar, AccBroadcastEntry, AccBroadcastExtension, AccBroadcastMessage } from "../../../shared/telemetry/acc-broadcast";

export type AccBroadcastSourceState = "available" | "unavailable" | "stale" | "malformed";
export type AccBroadcastSourceReason = "ready" | "not-connected" | "not-registered" | "no-session" | "incomplete-grid" | "session-reset" | "source-timeout" | "malformed-datagram" | "sequence-gap" | "duplicate-car-index" | "too-many-competitors" | "invalid-driver-index" | "capture-overflow" | "malformed-capture-record";
export interface AccBroadcastSnapshot extends Partial<AccBroadcastExtension> { source: { state: AccBroadcastSourceState; reasonCode: AccBroadcastSourceReason }; extension?: AccBroadcastExtension; }

const sessionType = (value: number): string => ({ 0: "practice", 4: "qualifying", 9: "superpole", 10: "race", 11: "hotlap", 12: "hotstint", 13: "hotlap_superpole", 14: "replay" } as Record<number, string>)[value] ?? "unknown";
const location = (value: number): string => ({ 1: "track", 2: "pit_lane", 3: "pit_entry", 4: "pit_exit" } as Record<number, string>)[value] ?? "unknown";

export class AccBroadcastState {
  private sessionIndex = -1;
  private sessionTypeValue = "unknown";
  private phaseValue = 0;
  private playerCarIndex = -1;
  private connected = false;
  private registered = false;
  private malformedReason: AccBroadcastSourceReason | null = null;
  private lastRealtimeAt = -Infinity;
  private readonly entries = new Map<number, AccBroadcastEntry>();
  private readonly cars = new Map<number, AccBroadcastCar>();
  private readonly carUpdatedAt = new Map<number, number>();
  private readonly now: () => number;
  private readonly competitorStaleMs: number;

  constructor(options: { now?: () => number; competitorStaleMs?: number } = {}) { this.now = options.now ?? Date.now; this.competitorStaleMs = options.competitorStaleMs ?? 1_000; }
  setSocketConnected(value: boolean): void { this.connected = value; if (!value) this.clear("not-connected"); }
  setRegistered(value: boolean): void { this.registered = value; if (!value) this.clear("not-registered"); }
  markMalformed(reason: AccBroadcastSourceReason = "malformed-datagram"): void { this.clear(reason); this.malformedReason = reason; }
  apply(message: AccBroadcastMessage, receivedAt = this.now()): void {
    if (message.type === "realtime-update") {
    this.connected = true; this.registered = true;
      this.sessionIndex = message.sessionIndex; this.sessionTypeValue = sessionType(message.sessionType); this.phaseValue = message.phase; this.lastRealtimeAt = receivedAt;
      if (message.focusedCarIndex >= 0) this.playerCarIndex = message.focusedCarIndex;
      return;
    }
    if (message.type === "entry-list") {
      if (message.carIndexes.length === 0 || message.carIndexes.length > 64 || new Set(message.carIndexes).size !== message.carIndexes.length) { this.markMalformed(message.carIndexes.length > 64 ? "too-many-competitors" : "duplicate-car-index"); return; }
      const allowed = new Set(message.carIndexes);
      for (const carIndex of this.cars.keys()) if (!allowed.has(carIndex)) { this.cars.delete(carIndex); this.carUpdatedAt.delete(carIndex); }
      return;
    }
    if (message.type === "entry-list-car") { if (!Number.isInteger(message.carIndex) || message.drivers.length === 0 || message.drivers.length <= message.currentDriverIndex) { this.markMalformed("invalid-driver-index"); return; } this.entries.set(message.carIndex, message); return; }
    if (message.type === "realtime-car-update") { this.cars.set(message.carIndex, message); this.carUpdatedAt.set(message.carIndex, receivedAt); }
  }
  hasEntry(carIndex: number): boolean { return this.entries.has(carIndex); }
  setPlayerCarIndex(carIndex: number): void { if (Number.isInteger(carIndex) && carIndex >= 0) this.playerCarIndex = carIndex; }
  reset(): void { this.sessionIndex = -1; this.sessionTypeValue = "unknown"; this.phaseValue = 0; this.playerCarIndex = -1; this.connected = false; this.registered = false; this.malformedReason = null; this.lastRealtimeAt = -Infinity; this.entries.clear(); this.cars.clear(); this.carUpdatedAt.clear(); }
  snapshot(): AccBroadcastSnapshot {
    if (this.malformedReason) return { source: { state: "malformed", reasonCode: this.malformedReason } };
    if (!this.connected) return { source: { state: "unavailable", reasonCode: "not-connected" } };
    if (!this.registered) return { source: { state: "unavailable", reasonCode: "not-registered" } };
    if (this.sessionIndex < 0) return { source: { state: "unavailable", reasonCode: "no-session" } };
    if (this.now() - this.lastRealtimeAt > this.competitorStaleMs) return { source: { state: "stale", reasonCode: "source-timeout" } };
    const rows = [...this.cars.values()].map((car) => ({ car, entry: this.entries.get(car.carIndex) })).filter((row): row is { car: AccBroadcastCar; entry: AccBroadcastEntry } => !!row.entry && row.entry.drivers.length > row.car.driverIndex).sort((a, b) => a.car.carIndex - b.car.carIndex);
    if (!rows.length || rows.length !== this.entries.size || this.playerCarIndex < 0 || !rows.some(({ car }) => car.carIndex === this.playerCarIndex)) return { source: { state: "unavailable", reasonCode: "incomplete-grid" } };
    const extension: AccBroadcastExtension = {
      sessionIndex: this.sessionIndex, sessionType: this.sessionTypeValue, phase: this.phaseValue, playerCarIndex: this.playerCarIndex,
      playerCarClassId: rows.find(({ car }) => car.carIndex === this.playerCarIndex)?.entry.cupCategory.toString(),
      carIndex: rows.map(({ car }) => car.carIndex), driverId: rows.map(({ car }) => `${car.carIndex}:${car.driverIndex}`), driverName: rows.map(({ entry, car }) => `${entry.drivers[car.driverIndex]!.firstName} ${entry.drivers[car.driverIndex]!.lastName}`.trim()),
      carClassId: rows.map(({ entry }) => String(entry.cupCategory)), carClassName: rows.map(({ entry }) => String(entry.cupCategory)), lapsComplete: rows.map(({ car }) => car.laps), position: rows.map(({ car }) => car.position), pitStatus: rows.map(({ car }) => location(car.location) === "track" ? "out" : location(car.location)), trackLocation: rows.map(({ car }) => location(car.location)), positionX: rows.map(({ car }) => car.worldPosX), positionY: rows.map(() => 0), positionZ: rows.map(({ car }) => car.worldPosY), speed: rows.map(({ car }) => car.kmh / 3.6), yaw: rows.map(({ car }) => car.yaw), lastLapTime: rows.map(({ car }) => car.lastLapTimeMs === null ? 0 : car.lastLapTimeMs / 1000), lastLapValid: rows.map(({ car }) => car.lastLapValid), connected: rows.map(({ car }) => this.now() - (this.carUpdatedAt.get(car.carIndex) ?? 0) <= this.competitorStaleMs),
    };
    return { ...extension, source: { state: "available", reasonCode: "ready" }, extension };
  }
  private clear(reason: AccBroadcastSourceReason): void { this.entries.clear(); this.cars.clear(); this.carUpdatedAt.clear(); this.playerCarIndex = -1; if (reason !== "not-connected" && reason !== "not-registered" && reason !== "session-reset") this.malformedReason = reason; }
}
export const accBroadcastState = new AccBroadcastState();
