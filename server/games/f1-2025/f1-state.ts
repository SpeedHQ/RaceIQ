import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { F1ExtendedData, F1GridEntry } from "../../../shared/telemetry/f1-2025";
import { getF1CompoundName } from "../../../shared/racing/cars/f1"
import {
  F1_HEADER_SIZE,
  F1_PACKET_IDS,
  F1_SESSION_TYPES,
  type F1Header,
} from "./f1-wire";
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
} from "./f1-packet-decoders";

/**
 * Stateful accumulator for F1 2025 UDP telemetry.
 *
 * F1 splits telemetry across multiple packet types that arrive at different
 * rates. This accumulator orders decoded updates, maintains session caches,
 * and assembles a unified TelemetryPacket snapshot.
 */
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
  }

  /**
   * Feed a parsed F1 packet into the accumulator.
   * Emits a complete TelemetryPacket snapshot on every packet once base state is ready.
   * Each emission reflects the latest merged state from all sources.
   */
  feed(header: F1Header, buf: Buffer): TelemetryPacket | null {
    if (header.sessionUID !== this.sessionUID) {
      this.reset();
      this.sessionUID = header.sessionUID;
    }
    this.playerCarIndex = header.playerCarIndex;

    const data = buf.subarray(F1_HEADER_SIZE);
    switch (header.packetId) {
      case F1_PACKET_IDS.MOTION:
        this.motion = decodeF1Motion(data, this.playerCarIndex) ?? this.motion;
        break;
      case F1_PACKET_IDS.SESSION:
        this.session = decodeF1Session(data) ?? this.session;
        break;
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
      case F1_PACKET_IDS.CAR_STATUS:
        this.carStatus = decodeF1CarStatus(data, this.playerCarIndex) ?? this.carStatus;
        break;
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
        return null;
    }

    if (this.motion && this.carTelemetry && this.lapData && this.session) {
      return this.buildPacket(header);
    }
    return null;
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

    const trackOrdinal = sess?.trackId ?? 0;
    const teamId = this.participants[this.playerCarIndex]?.teamId ?? 0;
    const carOrdinal = teamId;

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
      packetId: header.packetId,
      overallFrameIdentifier: header.overallFrameIdentifier,
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

      AccelerationX: -m.gForceX,
      AccelerationY: m.gForceY,
      AccelerationZ: m.gForceZ,

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

      CarOrdinal: carOrdinal,
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

      TrackOrdinal: trackOrdinal,

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
