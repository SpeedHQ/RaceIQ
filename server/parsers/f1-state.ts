import type { TelemetryPacket, F1ExtendedData, F1GridEntry } from "../../shared/types";
import { getF1CompoundName } from "../../shared/f1-car-data";

/**
 * Stateful accumulator for F1 2025 UDP telemetry.
 *
 * F1 splits telemetry across multiple packet types (Motion, CarTelemetry,
 * LapData, CarStatus, Session, Participants) that arrive at different rates.
 * This accumulator merges them into a single TelemetryPacket per frame.
 */

export interface F1Header {
  packetFormat: number; // u16 — 2025
  gameYear: number; // u8 — last two digits e.g. 25
  gameMajorVersion: number; // u8
  gameMinorVersion: number; // u8
  packetVersion: number; // u8
  packetId: number; // u8 (0-15)
  sessionUID: bigint; // u64
  sessionTime: number; // f32
  frameIdentifier: number; // u32
  overallFrameIdentifier: number; // u32
  playerCarIndex: number; // u8
  secondaryPlayerCarIndex: number; // u8
}

export const F1_HEADER_SIZE = 29;

export function parseF1Header(buf: Buffer): F1Header {
  return {
    packetFormat: buf.readUInt16LE(0),   // offset 0
    gameYear: buf.readUInt8(2),           // offset 2
    gameMajorVersion: buf.readUInt8(3),   // offset 3
    gameMinorVersion: buf.readUInt8(4),   // offset 4
    packetVersion: buf.readUInt8(5),      // offset 5
    packetId: buf.readUInt8(6),           // offset 6
    sessionUID: buf.readBigUInt64LE(7),   // offset 7
    sessionTime: buf.readFloatLE(15),     // offset 15
    frameIdentifier: buf.readUInt32LE(19),      // offset 19
    overallFrameIdentifier: buf.readUInt32LE(23), // offset 23
    playerCarIndex: buf.readUInt8(27),    // offset 27
    secondaryPlayerCarIndex: buf.readUInt8(28), // offset 28
  };
}


export class F1StateAccumulator {
  private sessionUID: bigint = 0n;
  // @ts-ignore — state tracking fields for future frame deduplication
  private _lastEmittedFrame: number = -1;
  // @ts-ignore
  private _lastEmittedSessionTime: number = -1;
  // @ts-ignore
  private _lastMotionHeader: F1Header | null = null;

  // Accumulated state from different packet types
  private motion: {
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    gForceX: number; gForceY: number; gForceZ: number;
    yaw: number; pitch: number; roll: number;
  } | null = null;

  private carTelemetry: {
    speed: number; throttle: number; brake: number; steer: number;
    gear: number; rpm: number; drs: boolean;
    clutch: number;
    tyreTempFL: number; tyreTempFR: number; tyreTempRL: number; tyreTempRR: number;
    tyresInnerTempFL: number; tyresInnerTempFR: number; tyresInnerTempRL: number; tyresInnerTempRR: number;
    brakeTempFL: number; brakeTempFR: number; brakeTempRL: number; brakeTempRR: number;
    tyrePressureFL: number; tyrePressureFR: number; tyrePressureRL: number; tyrePressureRR: number;
    engineTemperature: number;
    surfaceTypeFL: number; surfaceTypeFR: number; surfaceTypeRL: number; surfaceTypeRR: number;
    suggestedGear: number;
  } | null = null;

  private lapData: {
    currentLapTime: number; lastLapTime: number; bestLapTime: number;
    currentLapNum: number; position: number; totalDistance: number;
    lapDistance: number;
    sector: number; // 0=S1, 1=S2, 2=S3
    sector1Time: number; // seconds (0 if not set)
    sector2Time: number; // seconds (0 if not set)
    currentLapInvalid: number; penalties: number; totalWarnings: number;
    cornerCuttingWarnings: number; driverStatus: number;
    pitLaneTimerActive: number; pitLaneTimeInLaneInMS: number;
    speedTrapFastestSpeed: number; gridPosition: number;
    // All cars lap data for grid
    allCars: Array<{
      currentLapTime: number; lastLapTime: number; bestLapTime: number;
      position: number; pitStatus: number; numPitStops: number;
      totalDistance: number;
    }>;
  } | null = null;

  private carStatus: {
    fuelRemaining: number;
    fuelCapacity: number;
    tyreCompound: number; tyreVisualCompound: number; tyreAge: number;
    ersStore: number; ersDeployMode: number; ersDeployedThisLap: number; ersHarvestedThisLap: number;
    drsAllowed: boolean;
    tractionControl: number; antiLockBrakes: number; fuelMix: number;
    frontBrakeBias: number; pitLimiterStatus: number;
    fuelRemainingLaps: number; maxRPM: number; idleRPM: number; maxGears: number;
    drsActivationDistance: number; actualTyreCompound: number;
    vehicleFIAFlags: number;
    enginePowerICE: number; enginePowerMGUK: number;
    // All cars status for grid
    allCars: Array<{
      tyreCompound: number; tyreVisualCompound: number; tyreAge: number;
    }>;
  } | null = null;

  private carDamage: {
    tyreWearFL: number; tyreWearFR: number; tyreWearRL: number; tyreWearRR: number;
    tyresDamageFL: number; tyresDamageFR: number; tyresDamageRL: number; tyresDamageRR: number;
    brakesDamageFL: number; brakesDamageFR: number; brakesDamageRL: number; brakesDamageRR: number;
    tyreBlistersFL: number; tyreBlistsFR: number; tyreBlistersRL: number; tyreBlistersRR: number;
    frontLeftWingDamage: number; frontRightWingDamage: number;
    rearWingDamage: number; floorDamage: number; diffuserDamage: number;
    sidepodDamage: number;
    drsFault: number; ersFault: number;
    gearBoxDamage: number; engineDamage: number;
    engineMGUHWear: number; engineESWear: number; engineCEWear: number;
    engineICEWear: number; engineMGUKWear: number; engineTCWear: number;
  } | null = null;

  private carSetup: {
    frontWing: number; rearWing: number;
    onThrottle: number; offThrottle: number;
    frontCamber: number; rearCamber: number;
    frontToe: number; rearToe: number;
    frontSuspension: number; rearSuspension: number;
    frontAntiRollBar: number; rearAntiRollBar: number;
    frontRideHeight: number; rearRideHeight: number;
    brakePressure: number; brakeBias: number; engineBraking: number;
    rearLeftTyrePressure: number; rearRightTyrePressure: number;
    frontLeftTyrePressure: number; frontRightTyrePressure: number;
    fuelLoad: number;
  } | null = null;

  private motionEx: {
    suspensionPositionRL: number; suspensionPositionRR: number;
    suspensionPositionFL: number; suspensionPositionFR: number;
    suspensionVelocityRL: number; suspensionVelocityRR: number;
    suspensionVelocityFL: number; suspensionVelocityFR: number;
    wheelSpeedRL: number; wheelSpeedRR: number;
    wheelSpeedFL: number; wheelSpeedFR: number;
    wheelSlipRatioRL: number; wheelSlipRatioRR: number;
    wheelSlipRatioFL: number; wheelSlipRatioFR: number;
    wheelSlipAngleRL: number; wheelSlipAngleRR: number;
    wheelSlipAngleFL: number; wheelSlipAngleFR: number;
    wheelLatForceRL: number; wheelLatForceRR: number;
    wheelLatForceFL: number; wheelLatForceFR: number;
    wheelLongForceRL: number; wheelLongForceRR: number;
    wheelLongForceFL: number; wheelLongForceFR: number;
    wheelVertForceRL: number; wheelVertForceRR: number;
    wheelVertForceFL: number; wheelVertForceFR: number;
    heightOfCOGAboveGround: number;
    localVelocityX: number; localVelocityY: number; localVelocityZ: number;
    angularVelocityX: number; angularVelocityY: number; angularVelocityZ: number;
    angularAccelerationX: number; angularAccelerationY: number; angularAccelerationZ: number;
    frontWheelsAngle: number;
    frontAeroHeight: number; rearAeroHeight: number;
    frontRollAngle: number; rearRollAngle: number;
    chassisYaw: number; chassisPitch: number;
  } | null = null;

  private session: {
    trackId: number; weather: number; trackTemp: number; airTemp: number;
    sessionType: number; totalLaps: number; rainPercentage: number;
    safetyCarStatus: number; trackLength: number; pitSpeedLimit: number;
    formula: number; sector2LapDistanceStart: number; sector3LapDistanceStart: number;
    pitStopWindowIdealLap: number; pitStopWindowLatestLap: number;
  } | null = null;

  private participants: Array<{
    driverId: number; teamId: number; name: string;
  }> = [];

  // Per-driver session history (best/last sector times)
  private driverHistory: Map<number, {
    bestS1: number; bestS2: number; bestS3: number;
    lastS1: number; lastS2: number; lastS3: number;
    bestLapTime: number;
  }> = new Map();

  private playerCarIndex = 0;

  reset(): void {
    this.sessionUID = 0n;
    this.motion = null;
    this.carTelemetry = null;
    this.lapData = null;
    this.carStatus = null;
    this.carDamage = null;
    this.carSetup = null;
    this.motionEx = null;
    this.session = null;
    this.participants = [];
    this.driverHistory = new Map();
    this.playerCarIndex = 0;
    this._lastEmittedFrame = -1;
    this._lastEmittedSessionTime = -1;
    this._lastMotionHeader = null;
  }

  /**
   * Feed a parsed F1 packet into the accumulator.
   * Emits a complete TelemetryPacket snapshot on every packet once base state is ready.
   * Each emission reflects the latest merged state from all sources.
   */
  feed(header: F1Header, buf: Buffer): TelemetryPacket | null {
    // Reset on new session
    if (header.sessionUID !== this.sessionUID) {
      this.reset();
      this.sessionUID = header.sessionUID;
    }
    this.playerCarIndex = header.playerCarIndex;

    const data = buf.subarray(F1_HEADER_SIZE);

    switch (header.packetId) {
      case 0: this.parseMotion(data); this._lastMotionHeader = header; break;
      case 1: this.parseSession(data); break;
      case 2: this.parseLapData(data); break;
      case 4: this.parseParticipants(data); break;
      case 5: this.parseCarSetup(data); break;
      case 6: this.parseCarTelemetry(data); break;
      case 7: this.parseCarStatus(data); break;
      case 10: this.parseCarDamage(data); break;
      case 11: this.parseSessionHistory(data); break;
      case 13: this.parseMotionEx(data); break;
      default: return null;
    }

    // Emit on every packet — complete snapshot of all accumulated state
    if (this.motion && this.carTelemetry && this.lapData && this.session) {
      return this.buildPacket(header);
    }

    return null;
  }

  private parseMotion(data: Buffer): void {
    const idx = this.playerCarIndex;
    // CarMotionData: 60 bytes per car
    // Offsets: posX(0), posY(4), posZ(8), velX(12), velY(16), velZ(20),
    // forwardDirX(24 i16), Y(26), Z(28), rightDirX(30 i16), Y(32), Z(34),
    // gForceLateral(36 f32), gForceLongitudinal(40 f32), gForceVertical(44 f32),
    // yaw(48 f32), pitch(52 f32), roll(56 f32)
    const carSize = 60;
    const offset = idx * carSize;
    if (data.length < offset + carSize) return;

    this.motion = {
      posX: data.readFloatLE(offset + 0),
      posY: data.readFloatLE(offset + 4),
      posZ: data.readFloatLE(offset + 8),
      velX: data.readFloatLE(offset + 12),
      velY: data.readFloatLE(offset + 16),
      velZ: data.readFloatLE(offset + 20),
      gForceX: data.readFloatLE(offset + 36),  // m_gForceLateral
      gForceY: data.readFloatLE(offset + 40),  // m_gForceLongitudinal
      gForceZ: data.readFloatLE(offset + 44),  // m_gForceVertical
      yaw: data.readFloatLE(offset + 48),
      pitch: data.readFloatLE(offset + 52),
      roll: data.readFloatLE(offset + 56),
    };
  }

  private parseSession(data: Buffer): void {
    // PacketSessionData offsets (after header):
    // weather(0 u8), trackTemp(1 i8), airTemp(2 i8), totalLaps(3 u8),
    // trackLength(4 u16), sessionType(6 u8), trackId(7 i8), formula(8 u8),
    // sessionTimeLeft(9 u16), sessionDuration(11 u16), pitSpeedLimit(13 u8),
    // gamePaused(14 u8), isSpectating(15 u8), spectatorCarIndex(16 u8),
    // sliProNativeSupport(17 u8), numMarshalZones(18 u8),
    // marshalZones(19, 21*5=105 bytes), safetyCarStatus(124 u8),
    // networkGame(125 u8), numWeatherForecastSamples(126 u8),
    // weatherForecastSamples(127, 64*8=512 bytes)
    // Each WeatherForecastSample is 8 bytes, rainPercentage is at byte 7 within sample.
    // First sample's rainPercentage is at offset 127 + 7 = 134.
    if (data.length < 8) return;

    // Read rain percentage from first weather forecast sample if available
    const numForecastSamples = data.length >= 127 ? data.readUInt8(126) : 0;
    let rainPercentage = 0;
    if (numForecastSamples > 0 && data.length >= 135) {
      rainPercentage = data.readUInt8(134); // first sample's m_rainPercentage
    }

    this.session = {
      weather: data.readUInt8(0),
      trackTemp: data.readInt8(1),
      airTemp: data.readInt8(2),
      totalLaps: data.readUInt8(3),
      trackLength: data.readUInt16LE(4),         // m_trackLength (meters)
      sessionType: data.readUInt8(6),
      trackId: data.readInt8(7),
      formula: data.readUInt8(8),                 // m_formula
      pitSpeedLimit: data.length >= 14 ? data.readUInt8(13) : 0,   // m_pitSpeedLimit (km/h)
      safetyCarStatus: data.length >= 125 ? data.readUInt8(124) : 0, // m_safetyCarStatus
      rainPercentage,
      // These fields are deeper in the session struct — after weatherForecastSamples (127 + 512 = 639)
      // and further session-specific fields. We'll read them if the buffer is large enough.
      // F1 2025 PacketSessionData layout after forecast samples:
      //   pitStopWindowIdealLap(645 u8), pitStopWindowLatestLap(646 u8),
      //   ... sector2LapDistanceStart and sector3LapDistanceStart are not directly in the session
      //   packet — these are typically derived. We set them to 0.
      sector2LapDistanceStart: 0,
      sector3LapDistanceStart: 0,
      pitStopWindowIdealLap: data.length >= 646 ? data.readUInt8(645) : 0,
      pitStopWindowLatestLap: data.length >= 647 ? data.readUInt8(646) : 0,
    };
  }

  private parseLapData(data: Buffer): void {
    // LapData: 57 bytes per car
    // Offsets: lastLapTimeInMS(0 u32), currentLapTimeInMS(4 u32),
    // sector1TimeMSPart(8 u16), sector1TimeMinutesPart(10 u8),
    // sector2TimeMSPart(11 u16), sector2TimeMinutesPart(13 u8),
    // deltaToCarInFrontMSPart(14 u16), deltaToCarInFrontMinutesPart(16 u8),
    // deltaToRaceLeaderMSPart(17 u16), deltaToRaceLeaderMinutesPart(19 u8),
    // lapDistance(20 f32), totalDistance(24 f32), safetyCarDelta(28 f32),
    // carPosition(32 u8), currentLapNum(33 u8), pitStatus(34 u8),
    // numPitStops(35 u8), sector(36 u8), currentLapInvalid(37 u8),
    // penalties(38 u8), totalWarnings(39 u8), cornerCuttingWarnings(40 u8),
    // numUnservedDriveThroughPens(41 u8), numUnservedStopGoPens(42 u8),
    // gridPosition(43 u8), driverStatus(44 u8), resultStatus(45 u8),
    // pitLaneTimerActive(46 u8), pitLaneTimeInLaneInMS(47 u16),
    // pitStopTimerInMS(49 u16), pitStopShouldServePen(51 u8),
    // speedTrapFastestSpeed(52 f32), speedTrapFastestLap(56 u8)
    // Total = 57 bytes
    const carSize = 57;
    const numCars = 22;
    const allCars: typeof this.lapData extends null ? never : NonNullable<typeof this.lapData>["allCars"] = [];

    for (let i = 0; i < numCars && data.length >= (i + 1) * carSize; i++) {
      const offset = i * carSize;
      allCars.push({
        lastLapTime: data.readUInt32LE(offset + 0) / 1000,      // m_lastLapTimeInMS
        currentLapTime: data.readUInt32LE(offset + 4) / 1000,    // m_currentLapTimeInMS
        bestLapTime: 0, // Not in LapData struct; comes from SessionHistory packet
        position: data.readUInt8(offset + 32),                    // m_carPosition
        pitStatus: data.readUInt8(offset + 34),                   // m_pitStatus
        numPitStops: data.readUInt8(offset + 35),                 // m_numPitStops
        totalDistance: data.readFloatLE(offset + 24),              // m_totalDistance
      });
    }

    const idx = this.playerCarIndex;
    const playerOffset = idx * carSize;
    if (data.length < playerOffset + carSize) return;

    // Sector times: minutes*60000 + ms part
    const s1Ms = data.readUInt16LE(playerOffset + 8);
    const s1Min = data.readUInt8(playerOffset + 10);
    const s2Ms = data.readUInt16LE(playerOffset + 11);
    const s2Min = data.readUInt8(playerOffset + 13);

    this.lapData = {
      lastLapTime: data.readUInt32LE(playerOffset + 0) / 1000,     // m_lastLapTimeInMS
      currentLapTime: data.readUInt32LE(playerOffset + 4) / 1000,  // m_currentLapTimeInMS
      bestLapTime: 0, // Not in LapData struct; comes from SessionHistory packet
      currentLapNum: data.readUInt8(playerOffset + 33),             // m_currentLapNum
      position: data.readUInt8(playerOffset + 32),                  // m_carPosition
      totalDistance: data.readFloatLE(playerOffset + 24),            // m_totalDistance
      lapDistance: data.readFloatLE(playerOffset + 20),              // m_lapDistance
      sector: data.readUInt8(playerOffset + 36),                    // m_sector (0=S1, 1=S2, 2=S3)
      sector1Time: (s1Min * 60000 + s1Ms) / 1000,                  // to seconds
      sector2Time: (s2Min * 60000 + s2Ms) / 1000,                  // to seconds
      currentLapInvalid: data.readUInt8(playerOffset + 37),         // m_currentLapInvalid
      penalties: data.readUInt8(playerOffset + 38),                 // m_penalties (seconds)
      totalWarnings: data.readUInt8(playerOffset + 39),             // m_totalWarnings
      cornerCuttingWarnings: data.readUInt8(playerOffset + 40),     // m_cornerCuttingWarnings
      driverStatus: data.readUInt8(playerOffset + 44),              // m_driverStatus
      pitLaneTimerActive: data.readUInt8(playerOffset + 46),        // m_pitLaneTimerActive
      pitLaneTimeInLaneInMS: data.readUInt16LE(playerOffset + 47),  // m_pitLaneTimeInLaneInMS
      speedTrapFastestSpeed: data.readFloatLE(playerOffset + 52),   // m_speedTrapFastestSpeed
      gridPosition: data.readUInt8(playerOffset + 43),              // m_gridPosition
      allCars,
    };
  }

  private parseParticipants(data: Buffer): void {
    // ParticipantData: 57 bytes per participant
    // Offsets: aiControlled(0 u8), driverId(1 u8), networkId(2 u8),
    // teamId(3 u8), myTeam(4 u8), raceNumber(5 u8), nationality(6 u8),
    // name(7 char[32]), yourTelemetry(39 u8), showOnlineNames(40 u8),
    // techLevel(41 u16), platform(43 u8), numColours(44 u8),
    // liveryColours(45, 4*3=12 bytes)
    // Total = 7 + 32 + 1 + 1 + 2 + 1 + 1 + 12 = 57 bytes
    const numActiveCars = data.readUInt8(0);
    const participantData = data.subarray(1);
    const carSize = 57;
    this.participants = [];

    for (let i = 0; i < numActiveCars && participantData.length >= (i + 1) * carSize; i++) {
      const offset = i * carSize;
      // Name is 32 bytes null-terminated string at offset 7
      const nameBytes = participantData.subarray(offset + 7, offset + 7 + 32);
      const nullIdx = nameBytes.indexOf(0);
      const name = nameBytes.subarray(0, nullIdx >= 0 ? nullIdx : 32).toString("utf8");

      this.participants.push({
        driverId: participantData.readUInt8(offset + 1),   // m_driverId
        teamId: participantData.readUInt8(offset + 3),     // m_teamId
        name,
      });
    }
  }

  private parseCarTelemetry(data: Buffer): void {
    // CarTelemetryData: 60 bytes per car
    // Offsets: speed(0 u16), throttle(2 f32), steer(6 f32), brake(10 f32),
    // clutch(14 u8), gear(15 i8), engineRPM(16 u16), drs(18 u8),
    // revLightsPercent(19 u8), revLightsBitValue(20 u16),
    // brakesTemperature(22, u16[4]=8 bytes),
    // tyresSurfaceTemperature(30, u8[4]=4 bytes),
    // tyresInnerTemperature(34, u8[4]=4 bytes),
    // engineTemperature(38 u16), tyresPressure(40, f32[4]=16 bytes),
    // surfaceType(56, u8[4]=4 bytes)
    // Total = 60 bytes
    const idx = this.playerCarIndex;
    const carSize = 60;
    const offset = idx * carSize;
    if (data.length < offset + carSize) return;

    this.carTelemetry = {
      speed: data.readUInt16LE(offset + 0),       // m_speed (km/h)
      throttle: data.readFloatLE(offset + 2),      // m_throttle (0.0-1.0)
      steer: data.readFloatLE(offset + 6),         // m_steer (-1.0 to 1.0)
      brake: data.readFloatLE(offset + 10),        // m_brake (0.0-1.0)
      clutch: data.readUInt8(offset + 14),         // m_clutch (0-100)
      gear: data.readInt8(offset + 15),            // m_gear (1-8, N=0, R=-1)
      rpm: data.readUInt16LE(offset + 16),         // m_engineRPM
      drs: data.readUInt8(offset + 18) === 1,      // m_drs
      // Tyre surface temperatures are uint8[4] at offset 30 (RL, RR, FL, FR order in F1)
      tyreTempFL: data.readUInt8(offset + 32),     // m_tyresSurfaceTemperature[2]
      tyreTempFR: data.readUInt8(offset + 33),     // m_tyresSurfaceTemperature[3]
      tyreTempRL: data.readUInt8(offset + 30),     // m_tyresSurfaceTemperature[0]
      tyreTempRR: data.readUInt8(offset + 31),     // m_tyresSurfaceTemperature[1]
      // Tyre inner temperatures are uint8[4] at offset 34 (RL, RR, FL, FR order)
      tyresInnerTempFL: data.readUInt8(offset + 36), // m_tyresInnerTemperature[2]
      tyresInnerTempFR: data.readUInt8(offset + 37), // m_tyresInnerTemperature[3]
      tyresInnerTempRL: data.readUInt8(offset + 34), // m_tyresInnerTemperature[0]
      tyresInnerTempRR: data.readUInt8(offset + 35), // m_tyresInnerTemperature[1]
      // Brake temperatures are uint16[4] at offset 22 (RL, RR, FL, FR order)
      brakeTempFL: data.readUInt16LE(offset + 26), // m_brakesTemperature[2]
      brakeTempFR: data.readUInt16LE(offset + 28), // m_brakesTemperature[3]
      brakeTempRL: data.readUInt16LE(offset + 22), // m_brakesTemperature[0]
      brakeTempRR: data.readUInt16LE(offset + 24), // m_brakesTemperature[1]
      engineTemperature: data.readUInt16LE(offset + 38), // m_engineTemperature
      // Tyre pressures are float[4] at offset 40 (RL, RR, FL, FR order)
      tyrePressureFL: data.readFloatLE(offset + 48), // m_tyresPressure[2]
      tyrePressureFR: data.readFloatLE(offset + 52), // m_tyresPressure[3]
      tyrePressureRL: data.readFloatLE(offset + 40), // m_tyresPressure[0]
      tyrePressureRR: data.readFloatLE(offset + 44), // m_tyresPressure[1]
      // Surface type uint8[4] at offset 56 (RL, RR, FL, FR order)
      surfaceTypeFL: data.readUInt8(offset + 58),  // m_surfaceType[2]
      surfaceTypeFR: data.readUInt8(offset + 59),  // m_surfaceType[3]
      surfaceTypeRL: data.readUInt8(offset + 56),  // m_surfaceType[0]
      surfaceTypeRR: data.readUInt8(offset + 57),  // m_surfaceType[1]
      // suggestedGear is after the 22-car array in PacketCarTelemetryData
      suggestedGear: data.length >= 22 * carSize + 1 ? data.readInt8(22 * carSize) : 0,
    };
  }

  private parseCarStatus(data: Buffer): void {
    // CarStatusData: 55 bytes per car
    // Offsets: tractionControl(0 u8), antiLockBrakes(1 u8), fuelMix(2 u8),
    // frontBrakeBias(3 u8), pitLimiterStatus(4 u8), fuelInTank(5 f32),
    // fuelCapacity(9 f32), fuelRemainingLaps(13 f32), maxRPM(17 u16),
    // idleRPM(19 u16), maxGears(21 u8), drsAllowed(22 u8),
    // drsActivationDistance(23 u16), actualTyreCompound(25 u8),
    // visualTyreCompound(26 u8), tyresAgeLaps(27 u8), vehicleFIAFlags(28 i8),
    // enginePowerICE(29 f32), enginePowerMGUK(33 f32), ersStoreEnergy(37 f32),
    // ersDeployMode(41 u8), ersHarvestedThisLapMGUK(42 f32),
    // ersHarvestedThisLapMGUH(46 f32), ersDeployedThisLap(50 f32),
    // networkPaused(54 u8)
    // Total = 55 bytes
    const numCars = 22;
    const carSize = 55;
    const allCars: Array<{ tyreCompound: number; tyreVisualCompound: number; tyreAge: number }> = [];

    for (let i = 0; i < numCars && data.length >= (i + 1) * carSize; i++) {
      const offset = i * carSize;
      allCars.push({
        tyreCompound: data.readUInt8(offset + 25),     // m_actualTyreCompound
        tyreVisualCompound: data.readUInt8(offset + 26), // m_visualTyreCompound
        tyreAge: data.readUInt8(offset + 27),           // m_tyresAgeLaps
      });
    }

    const idx = this.playerCarIndex;
    const offset = idx * carSize;
    if (data.length < offset + carSize) return;

    this.carStatus = {
      tractionControl: data.readUInt8(offset + 0),       // m_tractionControl
      antiLockBrakes: data.readUInt8(offset + 1),        // m_antiLockBrakes
      fuelMix: data.readUInt8(offset + 2),               // m_fuelMix
      frontBrakeBias: data.readUInt8(offset + 3),        // m_frontBrakeBias
      pitLimiterStatus: data.readUInt8(offset + 4),      // m_pitLimiterStatus
      fuelRemaining: data.readFloatLE(offset + 5),       // m_fuelInTank
      fuelCapacity: data.readFloatLE(offset + 9),        // m_fuelCapacity
      fuelRemainingLaps: data.readFloatLE(offset + 13),  // m_fuelRemainingLaps
      maxRPM: data.readUInt16LE(offset + 17),            // m_maxRPM
      idleRPM: data.readUInt16LE(offset + 19),           // m_idleRPM
      maxGears: data.readUInt8(offset + 21),             // m_maxGears
      drsAllowed: data.readUInt8(offset + 22) === 1,     // m_drsAllowed
      drsActivationDistance: data.readUInt16LE(offset + 23), // m_drsActivationDistance
      actualTyreCompound: data.readUInt8(offset + 25),   // m_actualTyreCompound
      tyreCompound: data.readUInt8(offset + 25),         // m_actualTyreCompound
      tyreVisualCompound: data.readUInt8(offset + 26),   // m_visualTyreCompound
      tyreAge: data.readUInt8(offset + 27),              // m_tyresAgeLaps
      vehicleFIAFlags: data.readInt8(offset + 28),       // m_vehicleFIAFlags
      enginePowerICE: data.readFloatLE(offset + 29),     // m_enginePowerICE (watts)
      enginePowerMGUK: data.readFloatLE(offset + 33),    // m_enginePowerMGUK (watts)
      ersStore: data.readFloatLE(offset + 37),           // m_ersStoreEnergy
      ersDeployMode: data.readUInt8(offset + 41),        // m_ersDeployMode
      ersDeployedThisLap: data.readFloatLE(offset + 50), // m_ersDeployedThisLap
      ersHarvestedThisLap:                               // MGU-K + MGU-H combined
        data.readFloatLE(offset + 42) + data.readFloatLE(offset + 46),
      allCars,
    };
  }

  private parseCarSetup(data: Buffer): void {
    // CarSetupData: 50 bytes per car
    const idx = this.playerCarIndex;
    const carSize = 50;
    const offset = idx * carSize;
    if (data.length < offset + carSize) return;

    this.carSetup = {
      frontWing: data.readUInt8(offset + 0),
      rearWing: data.readUInt8(offset + 1),
      onThrottle: data.readUInt8(offset + 2),
      offThrottle: data.readUInt8(offset + 3),
      frontCamber: data.readFloatLE(offset + 4),
      rearCamber: data.readFloatLE(offset + 8),
      frontToe: data.readFloatLE(offset + 12),
      rearToe: data.readFloatLE(offset + 16),
      frontSuspension: data.readUInt8(offset + 20),
      rearSuspension: data.readUInt8(offset + 21),
      frontAntiRollBar: data.readUInt8(offset + 22),
      rearAntiRollBar: data.readUInt8(offset + 23),
      frontRideHeight: data.readUInt8(offset + 24),
      rearRideHeight: data.readUInt8(offset + 25),
      brakePressure: data.readUInt8(offset + 26),
      brakeBias: data.readUInt8(offset + 27),
      engineBraking: data.readUInt8(offset + 28),
      rearLeftTyrePressure: data.readFloatLE(offset + 29),
      rearRightTyrePressure: data.readFloatLE(offset + 33),
      frontLeftTyrePressure: data.readFloatLE(offset + 37),
      frontRightTyrePressure: data.readFloatLE(offset + 41),
      fuelLoad: data.readFloatLE(offset + 46),
    };
  }

  private parseMotionEx(data: Buffer): void {
    // PacketMotionExData — player car only, no per-car array.
    // All values are sequential float32LE (4 bytes each).
    // Struct order (arrays are RL, RR, FL, FR):
    //   suspensionPosition[4], suspensionVelocity[4], suspensionAcceleration[4],
    //   wheelSpeed[4], wheelSlipRatio[4], wheelSlipAngle[4],
    //   wheelLatForce[4], wheelLongForce[4],
    //   heightOfCOGAboveGround,
    //   localVelocity[3], angularVelocity[3], angularAcceleration[3],
    //   frontWheelsAngle,
    //   wheelVertForce[4],
    //   frontAeroHeight, rearAeroHeight,
    //   frontRollAngle, rearRollAngle,
    //   chassisYaw, chassisPitch,
    //   wheelCamber[4], wheelCamberGain[4]
    let o = 0;
    const f = () => { const v = data.readFloatLE(o); o += 4; return v; };

    const suspensionPositionRL = f(); const suspensionPositionRR = f();
    const suspensionPositionFL = f(); const suspensionPositionFR = f();
    const suspensionVelocityRL = f(); const suspensionVelocityRR = f();
    const suspensionVelocityFL = f(); const suspensionVelocityFR = f();
    o += 16; // skip suspensionAcceleration[4]
    const wheelSpeedRL = f(); const wheelSpeedRR = f();
    const wheelSpeedFL = f(); const wheelSpeedFR = f();
    const wheelSlipRatioRL = f(); const wheelSlipRatioRR = f();
    const wheelSlipRatioFL = f(); const wheelSlipRatioFR = f();
    const wheelSlipAngleRL = f(); const wheelSlipAngleRR = f();
    const wheelSlipAngleFL = f(); const wheelSlipAngleFR = f();
    const wheelLatForceRL = f(); const wheelLatForceRR = f();
    const wheelLatForceFL = f(); const wheelLatForceFR = f();
    const wheelLongForceRL = f(); const wheelLongForceRR = f();
    const wheelLongForceFL = f(); const wheelLongForceFR = f();
    const heightOfCOGAboveGround = f();
    const localVelocityX = f(); const localVelocityY = f(); const localVelocityZ = f();
    const angularVelocityX = f(); const angularVelocityY = f(); const angularVelocityZ = f();
    const angularAccelerationX = f(); const angularAccelerationY = f(); const angularAccelerationZ = f();
    const frontWheelsAngle = f();
    const wheelVertForceRL = f(); const wheelVertForceRR = f();
    const wheelVertForceFL = f(); const wheelVertForceFR = f();
    const frontAeroHeight = f(); const rearAeroHeight = f();
    const frontRollAngle = f(); const rearRollAngle = f();
    const chassisYaw = f(); const chassisPitch = f();
    // skip wheelCamber[4] and wheelCamberGain[4]

    this.motionEx = {
      suspensionPositionRL, suspensionPositionRR, suspensionPositionFL, suspensionPositionFR,
      suspensionVelocityRL, suspensionVelocityRR, suspensionVelocityFL, suspensionVelocityFR,
      wheelSpeedRL, wheelSpeedRR, wheelSpeedFL, wheelSpeedFR,
      wheelSlipRatioRL, wheelSlipRatioRR, wheelSlipRatioFL, wheelSlipRatioFR,
      wheelSlipAngleRL, wheelSlipAngleRR, wheelSlipAngleFL, wheelSlipAngleFR,
      wheelLatForceRL, wheelLatForceRR, wheelLatForceFL, wheelLatForceFR,
      wheelLongForceRL, wheelLongForceRR, wheelLongForceFL, wheelLongForceFR,
      wheelVertForceRL, wheelVertForceRR, wheelVertForceFL, wheelVertForceFR,
      heightOfCOGAboveGround,
      localVelocityX, localVelocityY, localVelocityZ,
      angularVelocityX, angularVelocityY, angularVelocityZ,
      angularAccelerationX, angularAccelerationY, angularAccelerationZ,
      frontWheelsAngle,
      frontAeroHeight, rearAeroHeight,
      frontRollAngle, rearRollAngle,
      chassisYaw, chassisPitch,
    };
  }

  private parseCarDamage(data: Buffer): void {
    // CarDamageData: 46 bytes per car
    // Offsets: tyresWear(0, f32[4]=16 bytes), tyresDamage(16, u8[4]),
    // brakesDamage(20, u8[4]), tyreBlisters(24, u8[4]),
    // frontLeftWingDamage(28 u8), frontRightWingDamage(29 u8),
    // rearWingDamage(30 u8), floorDamage(31 u8), diffuserDamage(32 u8),
    // sidepodDamage(33 u8), drsFault(34 u8), ersFault(35 u8),
    // gearBoxDamage(36 u8), engineDamage(37 u8), engineMGUHWear(38 u8),
    // engineESWear(39 u8), engineCEWear(40 u8), engineICEWear(41 u8),
    // engineMGUKWear(42 u8), engineTCWear(43 u8), engineBlown(44 u8),
    // engineSeized(45 u8)
    // Total = 46 bytes
    const idx = this.playerCarIndex;
    const carSize = 46;
    const offset = idx * carSize;
    if (data.length < offset + carSize) return;

    // Tyre wear is float[4] at offset 0 (RL, RR, FL, FR order in F1)
    this.carDamage = {
      tyreWearFL: data.readFloatLE(offset + 8),   // m_tyresWear[2]
      tyreWearFR: data.readFloatLE(offset + 12),  // m_tyresWear[3]
      tyreWearRL: data.readFloatLE(offset + 0),   // m_tyresWear[0]
      tyreWearRR: data.readFloatLE(offset + 4),   // m_tyresWear[1]
      // Tyre damage u8[4] at offset 16 (RL, RR, FL, FR)
      tyresDamageFL: data.readUInt8(offset + 18),  // m_tyresDamage[2]
      tyresDamageFR: data.readUInt8(offset + 19),  // m_tyresDamage[3]
      tyresDamageRL: data.readUInt8(offset + 16),  // m_tyresDamage[0]
      tyresDamageRR: data.readUInt8(offset + 17),  // m_tyresDamage[1]
      // Brakes damage u8[4] at offset 20 (RL, RR, FL, FR)
      brakesDamageFL: data.readUInt8(offset + 22), // m_brakesDamage[2]
      brakesDamageFR: data.readUInt8(offset + 23), // m_brakesDamage[3]
      brakesDamageRL: data.readUInt8(offset + 20), // m_brakesDamage[0]
      brakesDamageRR: data.readUInt8(offset + 21), // m_brakesDamage[1]
      // Tyre blisters u8[4] at offset 24 (RL, RR, FL, FR)
      tyreBlistersFL: data.readUInt8(offset + 26), // m_tyreBlisters[2]
      tyreBlistsFR: data.readUInt8(offset + 27),   // m_tyreBlisters[3]
      tyreBlistersRL: data.readUInt8(offset + 24), // m_tyreBlisters[0]
      tyreBlistersRR: data.readUInt8(offset + 25), // m_tyreBlisters[1]
      frontLeftWingDamage: data.readUInt8(offset + 28),   // m_frontLeftWingDamage (0-100)
      frontRightWingDamage: data.readUInt8(offset + 29),  // m_frontRightWingDamage (0-100)
      rearWingDamage: data.readUInt8(offset + 30),        // m_rearWingDamage (0-100)
      floorDamage: data.readUInt8(offset + 31),           // m_floorDamage (0-100)
      diffuserDamage: data.readUInt8(offset + 32),        // m_diffuserDamage (0-100)
      sidepodDamage: data.readUInt8(offset + 33),         // m_sidepodDamage (0-100)
      drsFault: data.readUInt8(offset + 34),              // m_drsFault
      ersFault: data.readUInt8(offset + 35),              // m_ersFault
      gearBoxDamage: data.readUInt8(offset + 36),         // m_gearBoxDamage
      engineDamage: data.readUInt8(offset + 37),          // m_engineDamage
      engineMGUHWear: data.readUInt8(offset + 38),        // m_engineMGUHWear
      engineESWear: data.readUInt8(offset + 39),          // m_engineESWear
      engineCEWear: data.readUInt8(offset + 40),          // m_engineCEWear
      engineICEWear: data.readUInt8(offset + 41),         // m_engineICEWear
      engineMGUKWear: data.readUInt8(offset + 42),        // m_engineMGUKWear
      engineTCWear: data.readUInt8(offset + 43),          // m_engineTCWear
    };
  }

  private parseSessionHistory(data: Buffer): void {
    // PacketSessionHistoryData (per-driver, game cycles through all 22):
    // carIdx(0 u8), numLaps(1 u8), numTyreStints(2 u8),
    // bestLapTimeLapNum(3 u8), bestSector1LapNum(4 u8),
    // bestSector2LapNum(5 u8), bestSector3LapNum(6 u8),
    // lapHistoryData(7, 11 bytes each, up to 100 entries)
    // LapHistoryData: lapTimeInMS(0 u32), sector1TimeInMS(4 u16),
    //   sector2TimeInMS(6 u16), sector3TimeInMS(8 u16), lapValidBitFlags(10 u8)
    if (data.length < 7) return;

    const carIdx = data.readUInt8(0);
    const numLaps = data.readUInt8(1);
    const bestS1Lap = data.readUInt8(4); // 1-indexed lap number
    const bestS2Lap = data.readUInt8(5);
    const bestS3Lap = data.readUInt8(6);

    const LAP_ENTRY_SIZE = 11;
    const LAP_DATA_OFFSET = 7;

    let bestS1 = 0, bestS2 = 0, bestS3 = 0, bestLapTime = 0;
    let lastS1 = 0, lastS2 = 0, lastS3 = 0;

    // Read best sector times from the specific lap entries
    if (bestS1Lap > 0 && bestS1Lap <= numLaps) {
      const off = LAP_DATA_OFFSET + (bestS1Lap - 1) * LAP_ENTRY_SIZE;
      if (data.length >= off + LAP_ENTRY_SIZE) bestS1 = data.readUInt16LE(off + 4) / 1000;
    }
    if (bestS2Lap > 0 && bestS2Lap <= numLaps) {
      const off = LAP_DATA_OFFSET + (bestS2Lap - 1) * LAP_ENTRY_SIZE;
      if (data.length >= off + LAP_ENTRY_SIZE) bestS2 = data.readUInt16LE(off + 6) / 1000;
    }
    if (bestS3Lap > 0 && bestS3Lap <= numLaps) {
      const off = LAP_DATA_OFFSET + (bestS3Lap - 1) * LAP_ENTRY_SIZE;
      if (data.length >= off + LAP_ENTRY_SIZE) bestS3 = data.readUInt16LE(off + 8) / 1000;
    }

    // Read last completed lap sectors and best lap time
    if (numLaps > 0) {
      const lastOff = LAP_DATA_OFFSET + (numLaps - 1) * LAP_ENTRY_SIZE;
      if (data.length >= lastOff + LAP_ENTRY_SIZE) {
        const lapTimeMs = data.readUInt32LE(lastOff);
        lastS1 = data.readUInt16LE(lastOff + 4) / 1000;
        lastS2 = data.readUInt16LE(lastOff + 6) / 1000;
        lastS3 = data.readUInt16LE(lastOff + 8) / 1000;
        if (lapTimeMs > 0) bestLapTime = lapTimeMs / 1000;
      }

      // Find actual best lap time across all laps
      for (let i = 0; i < numLaps; i++) {
        const off = LAP_DATA_OFFSET + i * LAP_ENTRY_SIZE;
        if (data.length < off + LAP_ENTRY_SIZE) break;
        const lt = data.readUInt32LE(off);
        if (lt > 0 && (bestLapTime === 0 || lt / 1000 < bestLapTime)) {
          bestLapTime = lt / 1000;
        }
      }
    }

    this.driverHistory.set(carIdx, { bestS1, bestS2, bestS3, lastS1, lastS2, lastS3, bestLapTime });
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
      driverStatus: ld.driverStatus,
      pitLaneTimerActive: ld.pitLaneTimerActive,
      pitLaneTimeInLaneInMS: ld.pitLaneTimeInLaneInMS,
      speedTrapFastestSpeed: ld.speedTrapFastestSpeed,
      gridPosition: ld.gridPosition,
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
      Power: cs ? (cs.enginePowerICE + cs.enginePowerMGUK) / 745.7 : 0, // W to hp
      Torque: 0,

      Boost: 0,
      Fuel: cs && cs.fuelCapacity > 0 ? cs.fuelRemaining / cs.fuelCapacity : 0,

      DistanceTraveled: ld.lapDistance,
      BestLap: ld.bestLapTime,
      LastLap: ld.lastLapTime,
      CurrentLap: ld.currentLapTime,
      CurrentRaceTime: header.sessionTime,

      LapNumber: ld.currentLapNum,
      RacePosition: ld.position,

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

const F1_SESSION_TYPES: Record<number, string> = {
  0: "unknown",
  1: "practice-1",
  2: "practice-2",
  3: "practice-3",
  4: "short-practice",
  5: "qualifying-1",
  6: "qualifying-2",
  7: "qualifying-3",
  8: "short-qualifying",
  9: "one-shot-qualifying",
  10: "race",
  11: "race-2",
  12: "race-3",
  13: "time-trial",
};
