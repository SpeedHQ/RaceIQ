import { setTimeout as delay } from "node:timers/promises";
import { LMU_GAME_VERSION_OFFSET, LMU_SESSION_EVENT_OFFSET, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY, LMU_WHEEL, LMU_WHEEL_SIZE, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE } from "@raceiq/capture-formats/lmu/layout";

type Wheels = [number, number, number, number];
export interface NativeLmuInput {
  laps: number;
  sessionEvent?: number;
  fuel?: number;
  energy?: number | null;
  wear?: Wheels;
  fuelPerLap?: number;
  energyPerLap?: number;
  wearPerLap?: Wheels;
  scoringLagSeconds?: number;
  advanceSeconds?: number;
  inPits?: boolean;
  rainIntensity?: number;
}

/** Replaces only the OS shared-memory read; the production source encodes and dispatches every frame. */
export class NativeLmuMemory {
  readonly memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  private completed = 0;
  private event = 1;
  private command = 0;
  private clockOffset = 0;
  private fuel = 100;
  private energy = 1;
  private missingEnergy = false;
  private wear: Wheels = [0.1, 0.1, 0.1, 0.1];
  constructor() {
    const memory = this.memory;
    const telemetry = LMU_TELEMETRY_INFO_OFFSET;
    const scoring = LMU_SCORING_VEHICLES_OFFSET;
    const text = (offset: number, value: string) => memory.write(value, offset, "utf8");
    memory.writeInt32LE(1202, LMU_GAME_VERSION_OFFSET);
    memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
    memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
    memory.writeInt32LE(42, telemetry + LMU_TELEMETRY.id);
    text(telemetry + LMU_TELEMETRY.vehicleName, "Ferrari 499P #50");
    text(telemetry + LMU_TELEMETRY.vehicleModel, "Ferrari 499P");
    text(telemetry + LMU_TELEMETRY.trackName, "Circuit de la Sarthe");
    text(telemetry + LMU_TELEMETRY.frontTireCompoundName, "medium");
    text(telemetry + LMU_TELEMETRY.rearTireCompoundName, "medium");
    memory.writeDoubleLE(100, telemetry + LMU_TELEMETRY.fuelCapacity);
    memory.writeDoubleLE(8000, telemetry + LMU_TELEMETRY.engineRpm);
    memory.writeDoubleLE(10000, telemetry + LMU_TELEMETRY.engineMaxRpm);
    memory.writeDoubleLE(-100, telemetry + LMU_TELEMETRY.localVelocity + 16);
    memory.writeDoubleLE(0.7, telemetry + LMU_TELEMETRY.throttle);
    memory.writeInt32LE(4, telemetry + LMU_TELEMETRY.gear);
    memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
    memory.writeUInt8(5, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.gamePhase);
    memory.writeInt32LE(10, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session);
    memory.writeDoubleLE(6000, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
    memory.writeDoubleLE(24, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.ambientTemperature);
    memory.writeDoubleLE(31, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackTemperature);
    text(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName, "Circuit de la Sarthe");
    memory.writeInt32LE(42, scoring + LMU_SCORING_VEHICLE.id);
    memory.writeUInt8(1, scoring + LMU_SCORING_VEHICLE.isPlayer);
    memory.writeUInt8(1, scoring + LMU_SCORING_VEHICLE.place);
    memory.writeUInt8(2, scoring + LMU_SCORING_VEHICLE.countLapFlag);
    text(scoring + LMU_SCORING_VEHICLE.driverName, "Native LMU Driver");
    text(scoring + LMU_SCORING_VEHICLE.vehicleName, "Ferrari 499P #50");
    for (let wheel = 0; wheel < 4; wheel++) {
      const offset = telemetry + LMU_TELEMETRY.wheels + wheel * LMU_WHEEL_SIZE;
      memory.writeDoubleLE(180, offset + LMU_WHEEL.pressureKpa);
      for (let position = 0; position < 3; position++) memory.writeDoubleLE(363.15, offset + LMU_WHEEL.temperature + position * 8);
    }
  }
  async advance(input: NativeLmuInput, dispatch: () => Promise<boolean>): Promise<void> {
    if (!Number.isInteger(input.laps) || input.laps < 0 || input.laps > 40) throw new Error("Invalid native LMU lap count");
    if (input.sessionEvent != null && input.sessionEvent !== this.event) {
      this.event = input.sessionEvent;
      this.completed = 0; this.clockOffset = 0; this.fuel = 100; this.energy = 1; this.missingEnergy = false; this.wear = [0.1, 0.1, 0.1, 0.1];
    }
    this.fuel = input.fuel ?? this.fuel;
    if (input.energy !== undefined) { this.missingEnergy = input.energy === null; if (input.energy != null) this.energy = input.energy; }
    this.wear = input.wear ?? this.wear;
    const fuelRate = input.fuelPerLap ?? 2;
    const energyRate = input.energyPerLap ?? 0.08;
    const wearRates: Wheels = input.wearPerLap ?? [0.008, 0.008, 0.008, 0.008];
    const telemetry = LMU_TELEMETRY_INFO_OFFSET;
    const scoring = LMU_SCORING_VEHICLES_OFFSET;
    if (input.rainIntensity !== undefined) this.memory.writeDoubleLE(input.rainIntensity, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.raining);
    this.clockOffset += input.advanceSeconds ?? 0;
    const clockOffset = 1 + this.clockOffset + ++this.command * 0.001;
    this.memory.writeUInt32LE(this.event, LMU_SESSION_EVENT_OFFSET);
    this.memory.writeUInt8(input.inPits ? 1 : 0, scoring + LMU_SCORING_VEHICLE.inPits);
    for (let frame = 0; frame <= input.laps * 120; frame++) {
      const progress = frame / 120;
      const lap = this.completed + Math.floor(progress);
      const fraction = progress - Math.floor(progress);
      const elapsed = clockOffset + (this.completed + progress) * 60;
      this.memory.writeDoubleLE(elapsed, telemetry + LMU_TELEMETRY.elapsedTime);
      this.memory.writeDoubleLE(clockOffset + lap * 60, telemetry + LMU_TELEMETRY.lapStartElapsedTime);
      this.memory.writeInt32LE(lap, telemetry + LMU_TELEMETRY.lapNumber);
      this.memory.writeInt32LE(1 + Math.floor(fraction * 3), telemetry + LMU_TELEMETRY.currentSector);
      this.memory.writeDoubleLE(elapsed - (input.scoringLagSeconds ?? 0), LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      this.memory.writeInt16LE(lap, scoring + LMU_SCORING_VEHICLE.totalLaps);
      this.memory.writeDoubleLE(fraction * 6000, scoring + LMU_SCORING_VEHICLE.lapDistance);
      this.memory.writeDoubleLE(lap ? 60 : 0, scoring + LMU_SCORING_VEHICLE.lastLapTime);
      this.memory.writeDoubleLE(lap ? 60 : 0, scoring + LMU_SCORING_VEHICLE.bestLapTime);
      this.memory.writeDoubleLE(Math.cos(fraction * Math.PI * 2) * 300, telemetry + LMU_TELEMETRY.position);
      this.memory.writeDoubleLE(Math.sin(fraction * Math.PI * 2) * 300, telemetry + LMU_TELEMETRY.position + 16);
      this.memory.writeDoubleLE(this.fuel - progress * fuelRate, telemetry + LMU_TELEMETRY.fuel);
      this.memory.writeFloatLE(this.missingEnergy ? NaN : this.energy - progress * energyRate, telemetry + LMU_TELEMETRY.virtualEnergy);
      for (let wheel = 0; wheel < 4; wheel++) this.memory.writeDoubleLE(1 - this.wear[wheel]! - progress * wearRates[wheel]!, telemetry + LMU_TELEMETRY.wheels + wheel * LMU_WHEEL_SIZE + LMU_WHEEL.wear);
      if (!await dispatch()) throw new Error(`Native LMU source rejected frame ${frame}`);
      await delay(12);
    }
    this.completed += input.laps;
    this.fuel -= input.laps * fuelRate;
    if (!this.missingEnergy) this.energy -= input.laps * energyRate;
    this.wear = this.wear.map((value, wheel) => value + input.laps * wearRates[wheel]!) as Wheels;
  }
}
