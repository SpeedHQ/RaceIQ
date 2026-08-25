import type { AccBroadcastCar, AccBroadcastEntry, AccBroadcastExtension, AccBroadcastMessage } from "../../../shared/telemetry/acc-broadcast";

const sessionType = (value: number): string => ({ 0: "practice", 1: "qualifying", 2: "race", 3: "race", 4: "hotlap", 5: "hotstint" } as Record<number, string>)[value] ?? "unknown";
const location = (value: number): string => ({ 1: "track", 2: "pit_lane", 3: "pit_entry", 4: "pit_exit" } as Record<number, string>)[value] ?? "unknown";

export class AccBroadcastState {
  private sessionIndex = -1;
  private sessionTypeValue = "unknown";
  private playerCarIndex = -1;
  private readonly entries = new Map<number, AccBroadcastEntry>();
  private readonly cars = new Map<number, AccBroadcastCar>();

  apply(message: AccBroadcastMessage): void {
    if (message.type === "realtime-update") {
      if (this.sessionIndex !== -1 && message.sessionIndex !== this.sessionIndex) {
        this.entries.clear();
        this.cars.clear();
      }
      this.sessionIndex = message.sessionIndex;
      this.sessionTypeValue = sessionType(message.sessionType);
      if (message.focusedCarIndex >= 0) this.playerCarIndex = message.focusedCarIndex;
      return;
    }
    if (message.type === "entry-list") {
      const allowed = new Set(message.carIndexes);
      for (const carIndex of this.entries.keys()) if (!allowed.has(carIndex)) this.entries.delete(carIndex);
      for (const carIndex of this.cars.keys()) if (!allowed.has(carIndex)) this.cars.delete(carIndex);
      return;
    }
    if (message.type === "entry-list-car") {
      this.entries.set(message.carIndex, message);
      return;
    }

    if (message.type === "realtime-car-update") {
      this.cars.set(message.carIndex, message);
    }
  }
  setPlayerCarIndex(carIndex: number): void {
    if (Number.isInteger(carIndex) && carIndex >= 0) this.playerCarIndex = carIndex;
  }

  reset(): void {
    this.sessionIndex = -1;
    this.sessionTypeValue = "unknown";
    this.playerCarIndex = -1;
    this.entries.clear();
    this.cars.clear();
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
      playerCarIndex: this.playerCarIndex,
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
      positionY: rows.map(() => 0),
      positionZ: rows.map(({ car }) => car.worldPosY),
    };
  }
}

export const accBroadcastState = new AccBroadcastState();
