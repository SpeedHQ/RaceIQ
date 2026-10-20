import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { F1ExtendedData, F1GridEntry } from "@raceiq/shared/telemetry/f1-2025";
import {
  F1_HEADER_SIZE,
  F1_PACKET_IDS,
  F1_SESSION_TYPES,
  type F1Header,
} from "@raceiq/capture-formats/f1-2025/f1-wire";
import {
  decodeF1CarDamage,
  decodeF1CarSetup,
  decodeF1CarStatus,
  decodeF1CarTelemetry,
  decodeF1FinalClassification,
  decodeF1LapData,
  decodeF1Motion,
  decodeF1MotionEx,
  decodeF1Participants,
  decodeF1Session,
  decodeF1Event,
  decodeF1SessionHistory,
  type F1CarDamageData,
  type F1CarSetupData,
  type F1CarStatusData,
  type F1CarTelemetryData,
  type F1DriverHistoryData,
  type F1FinalClassificationData,
  type F1LapData,
  type F1LapSectorData,
  type F1MotionData,
  type F1MotionExData,
  type F1ParticipantData,
  type F1SessionData,
  type F1SessionHistoryData,
  type F1EventData,
} from "./f1-packet-decoders";
import { getF1CompoundName } from "@raceiq/game-f1-2025-metadata/racing/compounds";


/**
 * Stateful accumulator for F1 2025 UDP telemetry.
 *
 * F1 splits telemetry across multiple packet types that arrive at different
 * rates. This accumulator orders decoded updates, maintains session caches,
 * and assembles a unified TelemetryPacket snapshot.
 */
export interface F1ParserCheckpointV1 {
  format: "raceiq:f1-2025-parser";
  version: 1;
  sessionUID: string;
  motion: F1MotionData | null;
  carTelemetry: F1CarTelemetryData | null;
  lapData: F1LapData | null;
  finalClassification: F1FinalClassificationData | null;
  carStatus: F1CarStatusData | null;
  carDamage: F1CarDamageData | null;
  carSetup: F1CarSetupData | null;
  motionEx: F1MotionExData | null;
  session: F1SessionData | null;
  participants: F1ParticipantData[];
  driverHistory: [number, F1DriverHistoryData][];
  driverLapSectors: [number, [number, F1LapSectorData][]][];
  playerCarIndex: number;
  carStatusUpdatedAt?: number;
  sessionUpdatedAt?: number;
  seenStartLightsAt?: number;
  raceStartAt?: number;
  lastHeaderSessionTime?: number;
}

function hasFiniteFields(value: unknown, fields: string[], booleanFields: string[] = []): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return fields.every((field) => typeof record[field] === "number" && Number.isFinite(record[field])) &&
    booleanFields.every((field) => typeof record[field] === "boolean");
}

function validF1StateObject(key: string, value: unknown): boolean {
  if (value === null) return true;
  const fields: Record<string, string[]> = {
    motion: ["posX", "posY", "posZ", "velX", "velY", "velZ", "gForceX", "gForceY", "gForceZ", "yaw", "pitch", "roll"],
    session: ["trackId", "weather", "trackTemp", "airTemp", "sessionType", "totalLaps", "rainPercentage", "safetyCarStatus", "trackLength", "pitSpeedLimit", "formula", "sector2LapDistanceStart", "sector3LapDistanceStart", "pitStopWindowIdealLap", "pitStopWindowLatestLap"],
    lapData: ["currentLapTime", "lastLapTime", "bestLapTime", "currentLapNum", "position", "totalDistance", "lapDistance", "sector", "sector1Time", "sector2Time", "currentLapInvalid", "penalties", "totalWarnings", "cornerCuttingWarnings", "driverStatus", "resultStatus", "pitLaneTimerActive", "pitLaneTimeInLaneInMS", "speedTrapFastestSpeed", "gridPosition"],
    finalClassification: ["position", "gridPosition", "resultStatus", "resultReason", "bestLapTime", "numPitStops"],
    carTelemetry: ["speed", "throttle", "brake", "steer", "gear", "rpm", "clutch", "tyreTempFL", "tyreTempFR", "tyreTempRL", "tyreTempRR", "tyresInnerTempFL", "tyresInnerTempFR", "tyresInnerTempRL", "tyresInnerTempRR", "brakeTempFL", "brakeTempFR", "brakeTempRL", "brakeTempRR", "tyrePressureFL", "tyrePressureFR", "tyrePressureRL", "tyrePressureRR", "engineTemperature", "surfaceTypeFL", "surfaceTypeFR", "surfaceTypeRL", "surfaceTypeRR", "suggestedGear"],
    carStatus: ["fuelRemaining", "fuelCapacity", "tyreCompound", "tyreVisualCompound", "tyreAge", "ersStore", "ersDeployMode", "ersDeployedThisLap", "ersHarvestedThisLap", "tractionControl", "antiLockBrakes", "fuelMix", "frontBrakeBias", "pitLimiterStatus", "fuelRemainingLaps", "maxRPM", "idleRPM", "maxGears", "drsActivationDistance", "actualTyreCompound", "vehicleFIAFlags", "enginePowerICE", "enginePowerMGUK"],
    carDamage: ["tyreWearFL", "tyreWearFR", "tyreWearRL", "tyreWearRR", "tyresDamageFL", "tyresDamageFR", "tyresDamageRL", "tyresDamageRR", "brakesDamageFL", "brakesDamageFR", "brakesDamageRL", "brakesDamageRR", "tyreBlistersFL", "tyreBlistsFR", "tyreBlistersRL", "tyreBlistersRR", "frontLeftWingDamage", "frontRightWingDamage", "rearWingDamage", "floorDamage", "diffuserDamage", "sidepodDamage", "drsFault", "ersFault", "gearBoxDamage", "engineDamage", "engineMGUHWear", "engineESWear", "engineCEWear", "engineICEWear", "engineMGUKWear", "engineTCWear"],
    carSetup: ["frontWing", "rearWing", "onThrottle", "offThrottle", "frontCamber", "rearCamber", "frontToe", "rearToe", "frontSuspension", "rearSuspension", "frontAntiRollBar", "rearAntiRollBar", "frontRideHeight", "rearRideHeight", "brakePressure", "brakeBias", "engineBraking", "rearLeftTyrePressure", "rearRightTyrePressure", "frontLeftTyrePressure", "frontRightTyrePressure", "fuelLoad"],
    motionEx: ["suspensionPositionRL", "suspensionPositionRR", "suspensionPositionFL", "suspensionPositionFR", "suspensionVelocityRL", "suspensionVelocityRR", "suspensionVelocityFL", "suspensionVelocityFR", "wheelSpeedRL", "wheelSpeedRR", "wheelSpeedFL", "wheelSpeedFR", "wheelSlipRatioRL", "wheelSlipRatioRR", "wheelSlipRatioFL", "wheelSlipRatioFR", "wheelSlipAngleRL", "wheelSlipAngleRR", "wheelSlipAngleFL", "wheelSlipAngleFR", "wheelLatForceRL", "wheelLatForceRR", "wheelLatForceFL", "wheelLatForceFR", "wheelLongForceRL", "wheelLongForceRR", "wheelLongForceFL", "wheelLongForceFR", "wheelVertForceRL", "wheelVertForceRR", "wheelVertForceFL", "wheelVertForceFR", "heightOfCOGAboveGround", "localVelocityX", "localVelocityY", "localVelocityZ", "angularVelocityX", "angularVelocityY", "angularVelocityZ", "angularAccelerationX", "angularAccelerationY", "angularAccelerationZ", "frontWheelsAngle", "frontAeroHeight", "rearAeroHeight", "frontRollAngle", "rearRollAngle", "chassisYaw", "chassisPitch"],
  };
  const booleans: Record<string, string[]> = {
    carTelemetry: ["drs"],
    carStatus: ["drsAllowed"],
  };
  const record = value as Record<string, unknown>;
  if (!fields[key] || !hasFiniteFields(value, fields[key], booleans[key] ?? [])) return false;
  if (key === "lapData") return Array.isArray(record.allCars) &&
    record.allCars.every((car) => hasFiniteFields(car, ["currentLapTime", "lastLapTime", "bestLapTime", "position", "pitStatus", "numPitStops", "totalDistance"]));
  if (key === "carStatus") return Array.isArray(record.allCars) &&
    record.allCars.every((car) => hasFiniteFields(car, ["tyreCompound", "tyreVisualCompound", "tyreAge"]));
  return true;
}

function validDriverHistory(value: unknown): boolean {
  return hasFiniteFields(value, ["bestS1", "bestS2", "bestS3", "lastS1", "lastS2", "lastS3", "bestLapTime"]);
}
export class F1StateAccumulator {
  private sessionUID: bigint = 0n;

  private motion: F1MotionData | null = null;
  private carTelemetry: F1CarTelemetryData | null = null;
  private lapData: F1LapData | null = null;
  private finalClassification: F1FinalClassificationData | null = null;
  private carStatus: F1CarStatusData | null = null;
  private carDamage: F1CarDamageData | null = null;
  private carSetup: F1CarSetupData | null = null;
  private motionEx: F1MotionExData | null = null;
  private session: F1SessionData | null = null;
  private participants: F1ParticipantData[] = [];
  private driverHistory = new Map<number, F1DriverHistoryData>();
  private driverLapSectors = new Map<number, Map<number, F1LapSectorData>>();
  private playerCarIndex = 0;
  private carStatusUpdatedAt: number | undefined;
  private sessionUpdatedAt: number | undefined;
  private seenStartLightsAt: number | undefined;
  private raceStartAt: number | undefined;
  private lastHeaderSessionTime: number | undefined;

  reset(): void {
    this.sessionUID = 0n;
    this.motion = null;
    this.carTelemetry = null;
    this.lapData = null;
    this.finalClassification = null;
    this.carStatus = null;
    this.carDamage = null;
    this.carSetup = null;
    this.motionEx = null;
    this.session = null;
    this.participants = [];
    this.driverHistory = new Map();
    this.playerCarIndex = 0;
    this.carStatusUpdatedAt = undefined;
    this.sessionUpdatedAt = undefined;
    this.seenStartLightsAt = undefined;
    this.raceStartAt = undefined;
    this.lastHeaderSessionTime = undefined;
  }

  captureCheckpoint(): Uint8Array {
    const checkpoint: F1ParserCheckpointV1 = {
      format: "raceiq:f1-2025-parser",
      version: 1,
      sessionUID: this.sessionUID.toString(10),
      motion: this.motion, carTelemetry: this.carTelemetry, lapData: this.lapData,
      finalClassification: this.finalClassification, carStatus: this.carStatus,
      carDamage: this.carDamage, carSetup: this.carSetup, motionEx: this.motionEx,
      session: this.session, participants: this.participants.slice(),
      driverHistory: [...this.driverHistory],
      driverLapSectors: [...this.driverLapSectors].map(([driver, sectors]) => [driver, [...sectors]]),
      playerCarIndex: this.playerCarIndex,
      carStatusUpdatedAt: this.carStatusUpdatedAt,
      sessionUpdatedAt: this.sessionUpdatedAt,
      seenStartLightsAt: this.seenStartLightsAt,
      raceStartAt: this.raceStartAt,
      lastHeaderSessionTime: this.lastHeaderSessionTime,
    };
    // JSON numbers support -0, but stringify normally discards its sign.
    const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
    return Buffer.from(json.stringify(checkpoint, (_key, value) =>
      typeof value === "number" && Object.is(value, -0) ? json.rawJSON("-0") : value), "utf8");
  }

  restoreCheckpoint(bytes: Uint8Array): void {
    let checkpoint: F1ParserCheckpointV1;
    try {
      checkpoint = JSON.parse(new TextDecoder().decode(bytes)) as F1ParserCheckpointV1;
    } catch {
      throw new Error("Invalid or unsupported F1-2025 parser checkpoint");
    }
    if (!checkpoint || checkpoint.format !== "raceiq:f1-2025-parser" || checkpoint.version !== 1 ||
        !Array.isArray(checkpoint.participants) || !checkpoint.participants.every(
          (participant) => hasFiniteFields(participant, ["driverId", "teamId"]) &&
            typeof participant.name === "string") ||
        !Array.isArray(checkpoint.driverHistory) || !checkpoint.driverHistory.every(
          (entry) => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
            validDriverHistory(entry[1])) ||
        !Array.isArray(checkpoint.driverLapSectors) || !checkpoint.driverLapSectors.every(
          (entry) => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
            Array.isArray(entry[1]) && entry[1].every((sector) => Array.isArray(sector) && sector.length === 2 &&
              Number.isInteger(sector[0]) && hasFiniteFields(sector[1], ["s1", "s2", "s3", "lapTime"]))) ||
        !Number.isInteger(checkpoint.playerCarIndex) ||
        !["carStatusUpdatedAt", "sessionUpdatedAt", "seenStartLightsAt", "raceStartAt", "lastHeaderSessionTime"]
          .every((key) => checkpoint[key as keyof F1ParserCheckpointV1] === undefined ||
            (typeof checkpoint[key as keyof F1ParserCheckpointV1] === "number" &&
              Number.isFinite(checkpoint[key as keyof F1ParserCheckpointV1]))) ||
        !["motion", "carTelemetry", "lapData", "finalClassification", "carStatus", "carDamage", "carSetup", "motionEx", "session"]
          .every((key) => validF1StateObject(key, checkpoint[key as keyof F1ParserCheckpointV1]))) {
      throw new Error("Invalid or unsupported F1-2025 parser checkpoint");
    }
    let sessionUID: bigint;
    try {
      if (typeof checkpoint.sessionUID !== "string" ||
          checkpoint.sessionUID.length > 20 ||
          !/^\d+$/.test(checkpoint.sessionUID)) throw new Error();
      sessionUID = BigInt(checkpoint.sessionUID);
      if (sessionUID > 0xffff_ffff_ffff_ffffn) throw new Error();
    } catch {
      throw new Error("Invalid or unsupported F1-2025 parser checkpoint");
    }
    this.sessionUID = sessionUID;
    this.motion = checkpoint.motion; this.carTelemetry = checkpoint.carTelemetry; this.lapData = checkpoint.lapData;
    this.finalClassification = checkpoint.finalClassification; this.carStatus = checkpoint.carStatus;
    this.carDamage = checkpoint.carDamage; this.carSetup = checkpoint.carSetup; this.motionEx = checkpoint.motionEx;
    this.session = checkpoint.session; this.participants = checkpoint.participants.slice();
    this.driverHistory = new Map(checkpoint.driverHistory);
    this.driverLapSectors = new Map(checkpoint.driverLapSectors.map(([driver, sectors]) => [driver, new Map(sectors)]));
    this.playerCarIndex = checkpoint.playerCarIndex;
    this.carStatusUpdatedAt = checkpoint.carStatusUpdatedAt;
    this.sessionUpdatedAt = checkpoint.sessionUpdatedAt;
    this.seenStartLightsAt = checkpoint.seenStartLightsAt;
    this.raceStartAt = checkpoint.raceStartAt;
    this.lastHeaderSessionTime = checkpoint.lastHeaderSessionTime;
  }

  /**
   * Feed a parsed F1 packet into the accumulator.
   * Emits a complete TelemetryPacket snapshot on every packet once base state is ready.
   * Each emission reflects the latest merged state from all sources.
   */
  feed(header: F1Header, buf: Buffer): TelemetryPacket | null {
    if (!this.applyState(header, buf)) return null;
    if (this.motion && this.carTelemetry && this.lapData && this.session) {
      return this.buildPacket(header);
    }
    return null;
  }

  primeParserState(header: F1Header, buf: Buffer): void {
    this.applyState(header, buf);
  }

  private applyState(header: F1Header, buf: Buffer): boolean {
    if (header.sessionUID !== this.sessionUID) {
      this.reset();
      this.sessionUID = header.sessionUID;
    }
    this.playerCarIndex = header.playerCarIndex;
    if (this.lastHeaderSessionTime !== undefined && header.sessionTime < this.lastHeaderSessionTime) {
      this.seenStartLightsAt = undefined;
      this.raceStartAt = undefined;
    }
    this.lastHeaderSessionTime = header.sessionTime;

    const data = buf.subarray(F1_HEADER_SIZE);
    switch (header.packetId) {
      case F1_PACKET_IDS.MOTION:
        this.motion = decodeF1Motion(data, this.playerCarIndex) ?? this.motion;
        break;
      case F1_PACKET_IDS.SESSION: {
        const session = decodeF1Session(data);
        if (session) {
          this.session = session;
          this.sessionUpdatedAt = header.sessionTime;
        }
        break;
      }
      case F1_PACKET_IDS.LAP_DATA:
        this.lapData = decodeF1LapData(data, this.playerCarIndex) ?? this.lapData;
        break;
      case F1_PACKET_IDS.PARTICIPANTS:
        this.participants = decodeF1Participants(data);
        break;
      case F1_PACKET_IDS.CAR_SETUP:
        this.carSetup = decodeF1CarSetup(data, this.playerCarIndex) ?? this.carSetup;
        break;
      case F1_PACKET_IDS.CAR_TELEMETRY:
        this.carTelemetry = decodeF1CarTelemetry(data, this.playerCarIndex) ?? this.carTelemetry;
        break;
      case F1_PACKET_IDS.CAR_STATUS: {
        const carStatus = decodeF1CarStatus(data, this.playerCarIndex);
        if (carStatus) {
          this.carStatus = carStatus;
          this.carStatusUpdatedAt = header.sessionTime;
        }
        break;
      }
      case F1_PACKET_IDS.EVENT: {
        const event = decodeF1Event(data);
        if (event) this.applyEvent(event, header.sessionTime);
        break;
      }
      case F1_PACKET_IDS.FINAL_CLASSIFICATION:
        this.finalClassification =
          decodeF1FinalClassification(data, this.playerCarIndex) ?? this.finalClassification;
        break;
      case F1_PACKET_IDS.CAR_DAMAGE:
        this.carDamage = decodeF1CarDamage(data, this.playerCarIndex) ?? this.carDamage;
        break;
      case F1_PACKET_IDS.SESSION_HISTORY: {
        const history = decodeF1SessionHistory(data);
        if (history) this.applySessionHistory(history);
        break;
      }
      case F1_PACKET_IDS.MOTION_EX:
        this.motionEx = decodeF1MotionEx(data);
        break;
      default:
        return false;
    }
    return true;
  }

  private applyEvent(event: F1EventData, sessionTime: number): void {
    if (event.code === "SSTA") {
      this.seenStartLightsAt = undefined;
      this.raceStartAt = undefined;
    } else if (event.code === "STLG") {
      this.seenStartLightsAt = event.numLights && event.numLights > 0 ? sessionTime : undefined;
    } else if (event.code === "LGOT" && this.seenStartLightsAt !== undefined && sessionTime >= this.seenStartLightsAt) {
      this.raceStartAt = sessionTime;
      this.seenStartLightsAt = undefined;
    }
  }

  private applySessionHistory(decoded: F1SessionHistoryData): void {
    let lapSectorMap = this.driverLapSectors.get(decoded.carIndex);
    if (!lapSectorMap) {
      lapSectorMap = new Map();
      this.driverLapSectors.set(decoded.carIndex, lapSectorMap);
    }

    for (const { lapNumber, sectors } of decoded.lapSectors) {
      const existing = lapSectorMap.get(lapNumber);
      const completeness =
        (sectors.s1 > 0 ? 1 : 0) +
        (sectors.s2 > 0 ? 1 : 0) +
        (sectors.s3 > 0 ? 1 : 0) +
        (sectors.lapTime > 0 ? 1 : 0);
      const existingCompleteness = existing
        ? (existing.s1 > 0 ? 1 : 0) +
          (existing.s2 > 0 ? 1 : 0) +
          (existing.s3 > 0 ? 1 : 0) +
          (existing.lapTime > 0 ? 1 : 0)
        : -1;
      if (completeness > existingCompleteness) {
        lapSectorMap.set(lapNumber, sectors);
      }
    }

    this.driverHistory.set(decoded.carIndex, decoded.history);
  }

  private buildPacket(header: F1Header): TelemetryPacket {
    const m = this.motion!;
    const ct = this.carTelemetry!;
    const ld = this.lapData!;
    const cs = this.carStatus;
    const cd = this.carDamage;
    const mx = this.motionEx;
    const sess = this.session;

    const trackId = sess?.trackId == null || sess.trackId < 0 ? "" : String(sess.trackId);
    const player = this.participants[this.playerCarIndex];
    const carId = player == null || player.teamId < 0 ? "" : String(player.teamId);

    // Build grid data
    const grid: F1GridEntry[] = [];
    if (ld.allCars.length > 0 && this.participants.length > 0) {
      const leaderBestDist = ld.allCars.reduce((max, c) => Math.max(max, c.totalDistance), 0);

      for (let i = 0; i < ld.allCars.length && i < this.participants.length; i++) {
        const car = ld.allCars[i];
        const participant = this.participants[i];
        const csEntry = cs?.allCars[i];

        const history = this.driverHistory.get(i);
        grid.push({
          position: car.position,
          driverId: participant.driverId,
          teamId: participant.teamId,
          name: participant.name,
          currentLapTime: car.currentLapTime,
          lastLapTime: car.lastLapTime,
          bestLapTime: history?.bestLapTime ?? car.bestLapTime,
          gapToLeader: car.position === 1 ? 0 : (leaderBestDist - car.totalDistance) / Math.max(1, ct.speed / 3.6),
          gapToCarAhead: 0, // computed after sort
          pitStatus: car.pitStatus,
          numPitStops: car.numPitStops,
          tyreCompound: csEntry ? getF1CompoundName(csEntry.tyreVisualCompound) : "unknown",
          tyreAge: csEntry?.tyreAge ?? 0,
          penalties: 0,
          bestS1: history?.bestS1 ?? 0,
          bestS2: history?.bestS2 ?? 0,
          bestS3: history?.bestS3 ?? 0,
          lastS1: history?.lastS1 ?? 0,
          lastS2: history?.lastS2 ?? 0,
          lastS3: history?.lastS3 ?? 0,
        });
      }

      // Sort by position and compute gap to car ahead
      grid.sort((a, b) => a.position - b.position);
      for (let i = 1; i < grid.length; i++) {
        grid[i].gapToCarAhead = grid[i].gapToLeader - grid[i - 1].gapToLeader;
      }
    }

    const f1: F1ExtendedData = {
      drsAllowed: cs?.drsAllowed ?? false,
      drsActivated: ct.drs,
      drsZoneApproaching: false, // TODO: from motion extra data
      ersStoreEnergy: cs?.ersStore ?? 0,
      ersDeployMode: cs?.ersDeployMode ?? 0,
      ersDeployedThisLap: cs?.ersDeployedThisLap ?? 0,
      ersHarvestedThisLap: cs?.ersHarvestedThisLap ?? 0,
      tyreCompound: cs ? getF1CompoundName(cs.tyreVisualCompound) : "unknown",
      tyreVisualCompound: cs?.tyreVisualCompound ?? 0,
      tyreAge: cs?.tyreAge ?? 0,
      weather: sess?.weather ?? 0,
      trackTemperature: sess?.trackTemp ?? 0,
      airTemperature: sess?.airTemp ?? 0,
      rainPercentage: sess?.rainPercentage ?? 0,
      sessionType: F1_SESSION_TYPES[sess?.sessionType ?? 0] ?? "unknown",
      totalLaps: sess?.totalLaps ?? 0,
      currentSector: ld.sector,
      sector1Time: ld.sector1Time,
      sector2Time: ld.sector2Time,
      lastS1: this.driverHistory.get(this.playerCarIndex)?.lastS1 ?? 0,
      lastS2: this.driverHistory.get(this.playerCarIndex)?.lastS2 ?? 0,
      lastS3: this.driverHistory.get(this.playerCarIndex)?.lastS3 ?? 0,
      // Per-lap completed sector times from SessionHistory, keyed by lap
      // number (1-indexed). Let downstream code look up the authoritative
      // split for a specific lap rather than the fragile "last" pointer.
      lapSectors: Object.fromEntries(this.driverLapSectors.get(this.playerCarIndex) ?? []),
      brakeTempFL: ct.brakeTempFL,
      brakeTempFR: ct.brakeTempFR,
      brakeTempRL: ct.brakeTempRL,
      brakeTempRR: ct.brakeTempRR,
      tyrePressureFL: ct.tyrePressureFL,
      tyrePressureFR: ct.tyrePressureFR,
      tyrePressureRL: ct.tyrePressureRL,
      tyrePressureRR: ct.tyrePressureRR,
      frontLeftWingDamage: cd?.frontLeftWingDamage ?? 0,
      frontRightWingDamage: cd?.frontRightWingDamage ?? 0,
      rearWingDamage: cd?.rearWingDamage ?? 0,
      floorDamage: cd?.floorDamage ?? 0,
      diffuserDamage: cd?.diffuserDamage ?? 0,
      sidepodDamage: cd?.sidepodDamage ?? 0,
      // Extended CarStatus fields
      tractionControl: cs?.tractionControl,
      antiLockBrakes: cs?.antiLockBrakes,
      fuelMix: cs?.fuelMix,
      frontBrakeBias: cs?.frontBrakeBias,
      pitLimiterStatus: cs?.pitLimiterStatus,
      fuelRemainingLaps: cs?.fuelRemainingLaps,
      drsActivationDistance: cs?.drsActivationDistance,
      actualTyreCompound: cs?.actualTyreCompound,
      vehicleFIAFlags: cs?.vehicleFIAFlags,
      vehicleFIAFlagsUpdatedAt: this.carStatusUpdatedAt,
      enginePowerICE: cs?.enginePowerICE,
      enginePowerMGUK: cs?.enginePowerMGUK,
      // Extended CarDamage fields
      tyresDamageFL: cd?.tyresDamageFL,
      tyresDamageFR: cd?.tyresDamageFR,
      tyresDamageRL: cd?.tyresDamageRL,
      tyresDamageRR: cd?.tyresDamageRR,
      brakesDamageFL: cd?.brakesDamageFL,
      brakesDamageFR: cd?.brakesDamageFR,
      brakesDamageRL: cd?.brakesDamageRL,
      brakesDamageRR: cd?.brakesDamageRR,
      tyreBlistersFL: cd?.tyreBlistersFL,
      tyreBlistsFR: cd?.tyreBlistsFR,
      tyreBlistersRL: cd?.tyreBlistersRL,
      tyreBlistersRR: cd?.tyreBlistersRR,
      drsFault: cd?.drsFault,
      ersFault: cd?.ersFault,
      gearBoxDamage: cd?.gearBoxDamage,
      engineDamage: cd?.engineDamage,
      engineMGUHWear: cd?.engineMGUHWear,
      engineESWear: cd?.engineESWear,
      engineCEWear: cd?.engineCEWear,
      engineICEWear: cd?.engineICEWear,
      engineMGUKWear: cd?.engineMGUKWear,
      engineTCWear: cd?.engineTCWear,
      // Extended CarTelemetry fields
      tyresInnerTempFL: ct.tyresInnerTempFL,
      tyresInnerTempFR: ct.tyresInnerTempFR,
      tyresInnerTempRL: ct.tyresInnerTempRL,
      tyresInnerTempRR: ct.tyresInnerTempRR,
      engineTemperature: ct.engineTemperature,
      surfaceTypeFL: ct.surfaceTypeFL,
      surfaceTypeFR: ct.surfaceTypeFR,
      surfaceTypeRL: ct.surfaceTypeRL,
      surfaceTypeRR: ct.surfaceTypeRR,
      suggestedGear: ct.suggestedGear,
      // Extended LapData fields
      currentLapInvalid: ld.currentLapInvalid,
      penalties: ld.penalties,
      totalWarnings: ld.totalWarnings,
      cornerCuttingWarnings: ld.cornerCuttingWarnings,
      resultStatus: this.finalClassification?.resultStatus ?? ld.resultStatus,
      resultReason: this.finalClassification?.resultReason,
      resultSource: this.finalClassification ? "final-classification" : "lap-data",
      driverStatus: ld.driverStatus,
      pitLaneTimerActive: ld.pitLaneTimerActive,
      pitLaneTimeInLaneInMS: ld.pitLaneTimeInLaneInMS,
      speedTrapFastestSpeed: ld.speedTrapFastestSpeed,
      gridPosition: this.finalClassification?.gridPosition ?? ld.gridPosition,
      // Extended Session fields
      safetyCarStatus: sess?.safetyCarStatus,
      safetyCarStatusUpdatedAt: this.sessionUpdatedAt,
      raceStartAt: this.raceStartAt,
      trackLength: sess?.trackLength,
      pitSpeedLimit: sess?.pitSpeedLimit,
      formula: sess?.formula,
      sector2LapDistanceStart: sess?.sector2LapDistanceStart,
      sector3LapDistanceStart: sess?.sector3LapDistanceStart,
      pitStopWindowIdealLap: sess?.pitStopWindowIdealLap,
      pitStopWindowLatestLap: sess?.pitStopWindowLatestLap,
      grid,
      setup: this.carSetup ?? undefined,
      motionEx: mx ? {
        wheelSlipAngleFL: mx.wheelSlipAngleFL, wheelSlipAngleFR: mx.wheelSlipAngleFR,
        wheelSlipAngleRL: mx.wheelSlipAngleRL, wheelSlipAngleRR: mx.wheelSlipAngleRR,
        wheelLatForceFL: mx.wheelLatForceFL, wheelLatForceFR: mx.wheelLatForceFR,
        wheelLatForceRL: mx.wheelLatForceRL, wheelLatForceRR: mx.wheelLatForceRR,
        wheelLongForceFL: mx.wheelLongForceFL, wheelLongForceFR: mx.wheelLongForceFR,
        wheelLongForceRL: mx.wheelLongForceRL, wheelLongForceRR: mx.wheelLongForceRR,
        wheelVertForceFL: mx.wheelVertForceFL, wheelVertForceFR: mx.wheelVertForceFR,
        wheelVertForceRL: mx.wheelVertForceRL, wheelVertForceRR: mx.wheelVertForceRR,
        frontWheelsAngle: mx.frontWheelsAngle,
        frontAeroHeight: mx.frontAeroHeight, rearAeroHeight: mx.rearAeroHeight,
        frontRollAngle: mx.frontRollAngle, rearRollAngle: mx.rearRollAngle,
        chassisYaw: mx.chassisYaw, chassisPitch: mx.chassisPitch,
        heightOfCOGAboveGround: mx.heightOfCOGAboveGround,
      } : undefined,
    };

    const packet: TelemetryPacket = {
      gameId: "f1-2025",
      sessionUID: header.sessionUID.toString(),
      f1,
      IsRaceOn: 1,
      TimestampMS: Math.round(header.sessionTime * 1000),

      EngineMaxRpm: cs?.maxRPM ?? 15000,
      EngineIdleRpm: cs?.idleRPM ?? 4000,
      CurrentEngineRpm: ct.rpm,

      AccelerationX: -m.gForceX * 9.81,
      AccelerationY: m.gForceY * 9.81,
      AccelerationZ: m.gForceZ * 9.81,

      VelocityX: -m.velX,
      VelocityY: m.velY,
      VelocityZ: m.velZ,

      AngularVelocityX: mx?.angularVelocityX ?? 0,
      AngularVelocityY: mx?.angularVelocityY ?? 0,
      AngularVelocityZ: mx?.angularVelocityZ ?? 0,

      Yaw: -m.yaw, // negate to match Forza display convention
      Pitch: m.pitch,
      Roll: m.roll,

      // Not provided by F1 — compute at display time from SuspensionTravelM
      NormSuspensionTravelFL: 0,
      NormSuspensionTravelFR: 0,
      NormSuspensionTravelRL: 0,
      NormSuspensionTravelRR: 0,

      TireSlipRatioFL: mx?.wheelSlipRatioFL ?? 0,
      TireSlipRatioFR: mx?.wheelSlipRatioFR ?? 0,
      TireSlipRatioRL: mx?.wheelSlipRatioRL ?? 0,
      TireSlipRatioRR: mx?.wheelSlipRatioRR ?? 0,

      // MotionEx provides per-wheel speed (km/h); fall back to estimate from car speed
      WheelRotationSpeedFL: mx ? mx.wheelSpeedFL / 0.36 : (ct.speed / 3.6) / 0.36,
      WheelRotationSpeedFR: mx ? mx.wheelSpeedFR / 0.36 : (ct.speed / 3.6) / 0.36,
      WheelRotationSpeedRL: mx ? mx.wheelSpeedRL / 0.36 : (ct.speed / 3.6) / 0.36,
      WheelRotationSpeedRR: mx ? mx.wheelSpeedRR / 0.36 : (ct.speed / 3.6) / 0.36,

      WheelOnRumbleStripFL: 0,
      WheelOnRumbleStripFR: 0,
      WheelOnRumbleStripRL: 0,
      WheelOnRumbleStripRR: 0,

      WheelInPuddleDepthFL: 0,
      WheelInPuddleDepthFR: 0,
      WheelInPuddleDepthRL: 0,
      WheelInPuddleDepthRR: 0,

      SurfaceRumbleFL_2: 0,
      SurfaceRumbleFR_2: 0,
      SurfaceRumbleRL_2: 0,
      SurfaceRumbleRR_2: 0,

      TireSlipCombinedFL_2: 0,

      SurfaceRumbleFL: 0,
      SurfaceRumbleFR: 0,
      SurfaceRumbleRL: 0,
      SurfaceRumbleRR: 0,

      // Tire slip angles: real MotionEx data or estimated from velocity/yaw
      TireSlipAngleFL: mx?.wheelSlipAngleFL ?? 0,
      TireSlipAngleFR: mx?.wheelSlipAngleFR ?? 0,
      TireSlipAngleRL: mx?.wheelSlipAngleRL ?? 0,
      TireSlipAngleRR: mx?.wheelSlipAngleRR ?? 0,

      TireCombinedSlipFL: mx ? Math.sqrt(mx.wheelSlipRatioFL ** 2 + mx.wheelSlipAngleFL ** 2) : 0,
      TireCombinedSlipFR: mx ? Math.sqrt(mx.wheelSlipRatioFR ** 2 + mx.wheelSlipAngleFR ** 2) : 0,
      TireCombinedSlipRL: mx ? Math.sqrt(mx.wheelSlipRatioRL ** 2 + mx.wheelSlipAngleRL ** 2) : 0,
      TireCombinedSlipRR: mx ? Math.sqrt(mx.wheelSlipRatioRR ** 2 + mx.wheelSlipAngleRR ** 2) : 0,

      // F1 MotionEx sends mm — convert to meters
      SuspensionTravelMFL: mx ? mx.suspensionPositionFL / 1000 : 0,
      SuspensionTravelMFR: mx ? mx.suspensionPositionFR / 1000 : 0,
      SuspensionTravelMRL: mx ? mx.suspensionPositionRL / 1000 : 0,
      SuspensionTravelMRR: mx ? mx.suspensionPositionRR / 1000 : 0,

      // Tire temps: F1 sends Celsius — keep as Celsius (convert-packet handles display)
      TireTempFL: ct.tyreTempFL,
      TireTempFR: ct.tyreTempFR,
      TireTempRL: ct.tyreTempRL,
      TireTempRR: ct.tyreTempRR,
      TireCarcassTempFL: ct.tyresInnerTempFL,
      TireCarcassTempFR: ct.tyresInnerTempFR,
      TireCarcassTempRL: ct.tyresInnerTempRL,
      TireCarcassTempRR: ct.tyresInnerTempRR,

      // Tire wear: F1 sends 0-100% from CarDamage packet, normalize to 0-1
      TireWearFL: cd ? cd.tyreWearFL / 100 : -1,
      TireWearFR: cd ? cd.tyreWearFR / 100 : -1,
      TireWearRL: cd ? cd.tyreWearRL / 100 : -1,
      TireWearRR: cd ? cd.tyreWearRR / 100 : -1,

      carId,
      CarClass: 0, // F1 is single-class
      CarPerformanceIndex: 0,
      DrivetrainType: 2, // AWD (hybrid with MGU-K)
      NumCylinders: 6, // V6 turbo hybrid

      // Negate X to match Forza's coordinate convention (and flipped extracted outlines)
      PositionX: -m.posX,
      PositionY: m.posY,
      PositionZ: m.posZ,

      Speed: ct.speed / 3.6, // km/h to m/s
      // F1 publishes both power channels in watts. TelemetryPacket.Power is
      // canonical watts; display consumers own any horsepower conversion.
      Power: cs ? cs.enginePowerICE + cs.enginePowerMGUK : 0,
      Torque: 0,

      Boost: 0,
      Fuel: cs && cs.fuelCapacity > 0 ? cs.fuelRemaining / cs.fuelCapacity : 0,
      FuelCapacity:
        cs && Number.isFinite(cs.fuelCapacity) && cs.fuelCapacity > 0
          ? cs.fuelCapacity
          : undefined,

      DistanceTraveled: ld.lapDistance,
      BestLap: this.finalClassification?.bestLapTime ?? ld.bestLapTime,
      LastLap: ld.lastLapTime,
      CurrentLap: ld.currentLapTime,
      CurrentRaceTime: header.sessionTime,

      LapNumber: ld.currentLapNum,
      RacePosition: this.finalClassification?.position ?? ld.position,

      // F1: throttle/brake are 0.0-1.0 float, normalize to 0-255
      Accel: Math.round(ct.throttle * 255),
      Brake: Math.round(ct.brake * 255),
      Clutch: Math.round(ct.clutch * 2.55), // 0-100 to 0-255
      HandBrake: 0,
      Gear: ct.gear + 1, // F1: -1=reverse, 0=neutral → offset by 1
      Steer: Math.round(ct.steer * 127), // F1: +1 right, same sign as Forza raw int8

      NormDrivingLine: 0,
      NormAIBrakeDiff: 0,

      trackId,

      // DRS/ERS per-packet tracking
      DrsActive: (cs?.drsAllowed && f1.drsActivated) ? 1 : 0,
      ErsStoreEnergy: cs?.ersStore ?? 0,
      ErsDeployMode: cs?.ersDeployMode ?? 0,
      ErsDeployed: cs?.ersDeployedThisLap ?? 0,
      ErsHarvested: cs?.ersHarvestedThisLap ?? 0,

      // Weather/track conditions
      WeatherType: sess?.weather ?? 0,
      TrackTemp: sess?.trackTemp ?? 0,
      AirTemp: sess?.airTemp ?? 0,
      RainPercent: sess?.rainPercentage ?? 0,

      // Brake temps (per-packet, survives CSV storage)
      BrakeTempFrontLeft: ct.brakeTempFL,
      BrakeTempFrontRight: ct.brakeTempFR,
      BrakeTempRearLeft: ct.brakeTempRL,
      BrakeTempRearRight: ct.brakeTempRR,

      // Tyre pressures (per-packet)
      TirePressureFrontLeft: ct.tyrePressureFL,
      TirePressureFrontRight: ct.tyrePressureFR,
      TirePressureRearLeft: ct.tyrePressureRL,
      TirePressureRearRight: ct.tyrePressureRR,

      // Tyre compound
      TyreCompound: cs?.tyreVisualCompound ?? 0,
    };

    return packet;
  }
}
