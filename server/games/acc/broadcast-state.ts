import type { AccBroadcastCar, AccBroadcastEntry, AccBroadcastExtension, AccBroadcastMessage } from "../../../shared/telemetry/acc-broadcast";

const sessionType = (value: number): string => ({ 0: "practice", 4: "qualifying", 9: "superpole", 10: "race", 11: "hotlap", 12: "hotstint", 13: "hotlap_superpole", 14: "replay" } as Record<number, string>)[value] ?? "unknown";
const location = (value: number): string => ({ 1: "track", 2: "pit_lane", 3: "pit_entry", 4: "pit_exit" } as Record<number, string>)[value] ?? "unknown";

export class AccBroadcastState {
  private sessionIndex = -1;
  private sessionTypeValue = "unknown";
  private phaseValue = 0;
  private playerCarIndex = -1;
  private readonly entries = new Map<number, AccBroadcastEntry>();
  private readonly cars = new Map<number, AccBroadcastCar>();
  private readonly carUpdatedAt = new Map<number, number>();
  private readonly now: () => number;
  private readonly competitorStaleMs: number;

  constructor(options: { now?: () => number; competitorStaleMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.competitorStaleMs = options.competitorStaleMs ?? 1_000;
  }
  apply(message: AccBroadcastMessage): void {
    if (message.type === "realtime-update") {
      if (this.sessionIndex !== -1 && message.sessionIndex !== this.sessionIndex) {
        this.entries.clear();
        this.cars.clear();
        this.carUpdatedAt.clear();
      }
      this.sessionIndex = message.sessionIndex;
      this.sessionTypeValue = sessionType(message.sessionType);
      this.phaseValue = message.phase;
      if (message.focusedCarIndex >= 0) this.playerCarIndex = message.focusedCarIndex;
      return;
    }
    if (message.type === "entry-list") {
      const allowed = new Set(message.carIndexes);
      for (const carIndex of this.cars.keys()) if (!allowed.has(carIndex)) {
        this.cars.delete(carIndex);
        this.carUpdatedAt.delete(carIndex);
      }
      return;
    }
    if (message.type === "entry-list-car") {
      this.entries.set(message.carIndex, message);
      return;
    }

    if (message.type === "realtime-car-update") {
      this.cars.set(message.carIndex, message);
      this.carUpdatedAt.set(message.carIndex, this.now());
    }
  }
  setPlayerCarIndex(carIndex: number): void {
    if (Number.isInteger(carIndex) && carIndex >= 0) this.playerCarIndex = carIndex;
  }

  reset(): void {
    this.sessionIndex = -1;
    this.sessionTypeValue = "unknown";
    this.phaseValue = 0;
    this.playerCarIndex = -1;
    this.entries.clear();
    this.cars.clear();
    this.carUpdatedAt.clear();
  }

  snapshot(): AccBroadcastExtension | undefined {
    if (this.sessionIndex < 0 || !this.cars.size) return undefined;
    const rows = [...this.cars.values()]
      .map((car) => ({ car, entry: this.entries.get(car.carIndex) }))
      .filter((row): row is { car: AccBroadcastCar; entry: AccBroadcastEntry } => !!row.entry && row.entry.drivers.length > 0)
      .sort((a, b) => a.car.carIndex - b.car.carIndex);
    if (!rows.length) return undefined;
    return {
      sessionIndex: this.sessionIndex,
      sessionType: this.sessionTypeValue,
      phase: this.phaseValue,
      playerCarIndex: this.playerCarIndex,
      playerCarClassId: rows.find(({ car }) => car.carIndex === this.playerCarIndex)?.entry.cupCategory.toString(),
      carIndex: rows.map(({ car }) => car.carIndex),
      driverId: rows.map(({ car }) => `${car.carIndex}:${car.driverIndex}`),
      driverName: rows.map(({ entry, car }) => {
        const driver = entry.drivers.find((candidate) => candidate === entry.drivers[entry.currentDriverIndex]) ?? entry.drivers[0]!;
        return `${driver.firstName} ${driver.lastName}`.trim() || String(car.carIndex);
      }),
      carClassId: rows.map(({ entry }) => String(entry.cupCategory)),
      carClassName: rows.map(({ entry }) => String(entry.cupCategory)),
      lapsComplete: rows.map(({ car }) => car.laps),
      pitStatus: rows.map(({ car }) => location(car.location) === "track" ? "out" : location(car.location)),
      trackLocation: rows.map(({ car }) => location(car.location)),
      positionX: rows.map(({ car }) => car.worldPosX),
      speed: rows.map(({ car }) => car.kmh / 3.6),
      yaw: rows.map(({ car }) => car.yaw),
      lastLapTime: rows.map(({ car }) => car.lastLapTimeMs === null ? 0 : car.lastLapTimeMs / 1000),
      lastLapValid: rows.map(({ car }) => car.lastLapValid),
      connected: rows.map(({ car }) => this.now() - (this.carUpdatedAt.get(car.carIndex) ?? 0) <= this.competitorStaleMs),
      positionY: rows.map(() => 0),
      positionZ: rows.map(({ car }) => car.worldPosY),
    };
  }
}

export const accBroadcastState = new AccBroadcastState();
