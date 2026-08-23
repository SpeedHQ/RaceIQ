
export interface F1GridEntry {
  position: number;
  driverId: number;
  teamId: number;
  name: string;
  carIndex?: number;
  isPlayer?: boolean;
  completedLapNumber?: number;
  completionSourceSequence?: number;
  lapValidBitFlags?: number;
  currentLapTime: number;
  lastLapTime: number;
  bestLapTime: number;
  gapToLeader: number;
  gapToCarAhead: number;
  pitStatus: number;
  numPitStops: number;
  tyreCompound: string;
  tyreAge: number;
  penalties: number;
  bestS1: number;
  bestS2: number;
  bestS3: number;
  lastS1: number;
  lastS2: number;
  lastS3: number;
}

export interface F1ExtendedData {
  drsAllowed: boolean;
  drsActivated: boolean;
  drsZoneApproaching: boolean;
  ersStoreEnergy: number;
  ersDeployMode: number;
  ersDeployedThisLap: number;
  ersHarvestedThisLap: number;
  tyreCompound: string;
  tyreVisualCompound: number;
  tyreAge: number;
  weather: number;
  trackTemperature: number;
  airTemperature: number;
  rainPercentage: number;
  sessionType: string;
  totalLaps: number;
  currentSector: number; // 0=S1, 1=S2, 2=S3
  sector1Time: number; // seconds (0 if not completed this lap)
  sector2Time: number; // seconds (0 if not completed this lap)
  lastS1: number; // definitive sector times from SessionHistory (0 if not yet received)
  lastS2: number;
  lastS3: number;
  /**
   * Per-lap completed sector times from the F1 SessionHistory packet, keyed by
   * 1-indexed lap number. Each entry is `{ s1, s2, s3, lapTime }` in seconds.
   * Prefer this over `lastS1/lastS2/lastS3` for specific-lap queries — the
   * "last" fields track whatever lap is currently in progress in the game, so
   * they reset to 0 the moment a new lap starts.
   */
  lapSectors?: Record<number, { s1: number; s2: number; s3: number; lapTime: number }>;
  // Damage (0-100, 0=no damage)
  // Brake temps (Celsius)
  brakeTempFL: number;
  brakeTempFR: number;
  brakeTempRL: number;
  brakeTempRR: number;
  // Tyre pressures (PSI)
  tyrePressureFL: number;
  tyrePressureFR: number;
  tyrePressureRL: number;
  tyrePressureRR: number;
  // Damage (0-100, 0=no damage)
  frontLeftWingDamage: number;
  frontRightWingDamage: number;
  rearWingDamage: number;
  floorDamage: number;
  diffuserDamage: number;
  sidepodDamage: number;
  // Extended CarStatus fields
  tractionControl?: number;
  antiLockBrakes?: number;
  fuelMix?: number;
  frontBrakeBias?: number;
  pitLimiterStatus?: number;
  fuelRemainingLaps?: number;
  drsActivationDistance?: number;
  actualTyreCompound?: number;
  vehicleFIAFlags?: number;
  enginePowerICE?: number;
  enginePowerMGUK?: number;
  // Extended CarDamage fields
  tyresDamageFL?: number;
  tyresDamageFR?: number;
  tyresDamageRL?: number;
  tyresDamageRR?: number;
  brakesDamageFL?: number;
  brakesDamageFR?: number;
  brakesDamageRL?: number;
  brakesDamageRR?: number;
  tyreBlistersFL?: number;
  tyreBlistsFR?: number;
  tyreBlistersRL?: number;
  tyreBlistersRR?: number;
  drsFault?: number;
  ersFault?: number;
  gearBoxDamage?: number;
  engineDamage?: number;
  engineMGUHWear?: number;
  engineESWear?: number;
  engineCEWear?: number;
  engineICEWear?: number;
  engineMGUKWear?: number;
  engineTCWear?: number;
  // Extended CarTelemetry fields
  tyresInnerTempFL?: number;
  tyresInnerTempFR?: number;
  tyresInnerTempRL?: number;
  tyresInnerTempRR?: number;
  engineTemperature?: number;
  surfaceTypeFL?: number;
  surfaceTypeFR?: number;
  surfaceTypeRL?: number;
  surfaceTypeRR?: number;
  suggestedGear?: number;
  // Extended LapData fields
  currentLapInvalid?: number;
  penalties?: number;
  totalWarnings?: number;
  cornerCuttingWarnings?: number;
  driverStatus?: number;
  resultStatus?: number;
  resultReason?: number;
  resultSource?: "lap-data" | "final-classification";
  pitLaneTimerActive?: number;
  pitLaneTimeInLaneInMS?: number;
  speedTrapFastestSpeed?: number;
  gridPosition?: number;
  // Extended Session fields
  safetyCarStatus?: number;
  trackLength?: number;
  pitSpeedLimit?: number;
  formula?: number;
  sector2LapDistanceStart?: number;
  sector3LapDistanceStart?: number;
  pitStopWindowIdealLap?: number;
  pitStopWindowLatestLap?: number;
  grid: F1GridEntry[];
  // Car setup (from PacketCarSetupData, packet ID 5)
  setup?: F1CarSetup;
  // MotionEx — per-packet detailed physics
  motionEx?: {
    wheelSlipAngleFL: number; wheelSlipAngleFR: number;
    wheelSlipAngleRL: number; wheelSlipAngleRR: number;
    wheelLatForceFL: number; wheelLatForceFR: number;
    wheelLatForceRL: number; wheelLatForceRR: number;
    wheelLongForceFL: number; wheelLongForceFR: number;
    wheelLongForceRL: number; wheelLongForceRR: number;
    wheelVertForceFL: number; wheelVertForceFR: number;
    wheelVertForceRL: number; wheelVertForceRR: number;
    frontWheelsAngle: number;
    frontAeroHeight: number; rearAeroHeight: number;
    frontRollAngle: number; rearRollAngle: number;
    chassisYaw: number; chassisPitch: number;
    heightOfCOGAboveGround: number;
  };
}

export interface F1CarSetup {
  frontWing: number;
  rearWing: number;
  onThrottle: number;       // differential on-throttle %
  offThrottle: number;      // differential off-throttle %
  frontCamber: number;      // degrees (negative)
  rearCamber: number;       // degrees (negative)
  frontToe: number;         // degrees
  rearToe: number;          // degrees
  frontSuspension: number;  // 1-11
  rearSuspension: number;   // 1-11
  frontAntiRollBar: number; // 1-11
  rearAntiRollBar: number;  // 1-11
  frontRideHeight: number;  // 1-50
  rearRideHeight: number;   // 1-50
  brakePressure: number;    // %
  brakeBias: number;        // %
  engineBraking: number;    // %
  rearLeftTyrePressure: number;   // PSI
  rearRightTyrePressure: number;  // PSI
  frontLeftTyrePressure: number;  // PSI
  frontRightTyrePressure: number; // PSI
  fuelLoad: number;         // kg
}
