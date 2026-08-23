export interface F1MotionCarData {
  carIndex: number; posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number; yaw: number;
}
export interface F1MotionData extends F1MotionCarData {
  gForceX: number; gForceY: number; gForceZ: number;
  pitch: number; roll: number; allCars: F1MotionCarData[];
}
export interface F1SessionData {
  trackId: number; weather: number; trackTemp: number; airTemp: number;
  sessionType: number; totalLaps: number; rainPercentage: number;
  safetyCarStatus: number; trackLength: number; pitSpeedLimit: number;
  formula: number; isSpectating: boolean; sector2LapDistanceStart: number; sector3LapDistanceStart: number;
  pitStopWindowIdealLap: number; pitStopWindowLatestLap: number;
}
export interface F1LapCarData {
  currentLapTime: number; lastLapTime: number; bestLapTime: number;
  position: number; pitStatus: number; numPitStops: number; totalDistance: number;
}
export interface F1LapData {
  currentLapTime: number; lastLapTime: number; bestLapTime: number;
  currentLapNum: number; position: number; totalDistance: number; lapDistance: number;
  sector: number; sector1Time: number; sector2Time: number;
  currentLapInvalid: number; penalties: number; totalWarnings: number;
  cornerCuttingWarnings: number; driverStatus: number; resultStatus: number;
  pitLaneTimerActive: number; pitLaneTimeInLaneInMS: number;
  speedTrapFastestSpeed: number; gridPosition: number; allCars: F1LapCarData[];
}
export interface F1FinalClassificationData {
  position: number; gridPosition: number; resultStatus: number; resultReason: number;
  bestLapTime: number; numPitStops: number;
}
export interface F1ParticipantData { driverId: number; teamId: number; name: string; }
export interface F1CarTelemetryData {
  speed: number; throttle: number; brake: number; steer: number; gear: number; rpm: number; drs: boolean; clutch: number;
  tyreTempFL: number; tyreTempFR: number; tyreTempRL: number; tyreTempRR: number;
  tyresInnerTempFL: number; tyresInnerTempFR: number; tyresInnerTempRL: number; tyresInnerTempRR: number;
  brakeTempFL: number; brakeTempFR: number; brakeTempRL: number; brakeTempRR: number;
  tyrePressureFL: number; tyrePressureFR: number; tyrePressureRL: number; tyrePressureRR: number;
  engineTemperature: number; surfaceTypeFL: number; surfaceTypeFR: number; surfaceTypeRL: number; surfaceTypeRR: number; suggestedGear: number;
}
export interface F1CarStatusEntry { tyreCompound: number; tyreVisualCompound: number; tyreAge: number; }
export interface F1CarStatusData {
  fuelRemaining: number; fuelCapacity: number; tyreCompound: number; tyreVisualCompound: number; tyreAge: number;
  ersStore: number; ersDeployMode: number; ersDeployedThisLap: number; ersHarvestedThisLap: number; drsAllowed: boolean;
  tractionControl: number; antiLockBrakes: number; fuelMix: number; frontBrakeBias: number; pitLimiterStatus: number;
  fuelRemainingLaps: number; maxRPM: number; idleRPM: number; maxGears: number; drsActivationDistance: number; actualTyreCompound: number;
  vehicleFIAFlags: number; enginePowerICE: number; enginePowerMGUK: number; allCars: F1CarStatusEntry[];
}
export interface F1CarSetupData {
  frontWing: number; rearWing: number; onThrottle: number; offThrottle: number;
  frontCamber: number; rearCamber: number; frontToe: number; rearToe: number;
  frontSuspension: number; rearSuspension: number; frontAntiRollBar: number; rearAntiRollBar: number;
  frontRideHeight: number; rearRideHeight: number; brakePressure: number; brakeBias: number; engineBraking: number;
  rearLeftTyrePressure: number; rearRightTyrePressure: number; frontLeftTyrePressure: number; frontRightTyrePressure: number; fuelLoad: number;
}
export interface F1MotionExData {
  suspensionPositionRL: number; suspensionPositionRR: number; suspensionPositionFL: number; suspensionPositionFR: number;
  suspensionVelocityRL: number; suspensionVelocityRR: number; suspensionVelocityFL: number; suspensionVelocityFR: number;
  wheelSpeedRL: number; wheelSpeedRR: number; wheelSpeedFL: number; wheelSpeedFR: number;
  wheelSlipRatioRL: number; wheelSlipRatioRR: number; wheelSlipRatioFL: number; wheelSlipRatioFR: number;
  wheelSlipAngleRL: number; wheelSlipAngleRR: number; wheelSlipAngleFL: number; wheelSlipAngleFR: number;
  wheelLatForceRL: number; wheelLatForceRR: number; wheelLatForceFL: number; wheelLatForceFR: number;
  wheelLongForceRL: number; wheelLongForceRR: number; wheelLongForceFL: number; wheelLongForceFR: number;
  wheelVertForceRL: number; wheelVertForceRR: number; wheelVertForceFL: number; wheelVertForceFR: number;
  heightOfCOGAboveGround: number; localVelocityX: number; localVelocityY: number; localVelocityZ: number;
  angularVelocityX: number; angularVelocityY: number; angularVelocityZ: number;
  angularAccelerationX: number; angularAccelerationY: number; angularAccelerationZ: number;
  frontWheelsAngle: number; frontAeroHeight: number; rearAeroHeight: number;
  frontRollAngle: number; rearRollAngle: number; chassisYaw: number; chassisPitch: number;
}
export interface F1CarDamageData {
  tyreWearFL: number; tyreWearFR: number; tyreWearRL: number; tyreWearRR: number;
  tyresDamageFL: number; tyresDamageFR: number; tyresDamageRL: number; tyresDamageRR: number;
  brakesDamageFL: number; brakesDamageFR: number; brakesDamageRL: number; brakesDamageRR: number;
  tyreBlistersFL: number; tyreBlistsFR: number; tyreBlistersRL: number; tyreBlistersRR: number;
  frontLeftWingDamage: number; frontRightWingDamage: number; rearWingDamage: number; floorDamage: number; diffuserDamage: number; sidepodDamage: number;
  drsFault: number; ersFault: number; gearBoxDamage: number; engineDamage: number;
  engineMGUHWear: number; engineESWear: number; engineCEWear: number; engineICEWear: number; engineMGUKWear: number; engineTCWear: number;
}
export interface F1LapSectorData { s1: number; s2: number; s3: number; lapTime: number; lapValidBitFlags?: number; }
export interface F1DriverHistoryData { bestS1: number; bestS2: number; bestS3: number; lastS1: number; lastS2: number; lastS3: number; bestLapTime: number; lastLapNumber: number; lastLapValidBitFlags: number; }
export interface F1SessionHistoryData {
  carIndex: number; history: F1DriverHistoryData; lapSectors: Array<{ lapNumber: number; sectors: F1LapSectorData; lapValidBitFlags: number }>;
}
export function decodeF1Motion(data: Buffer, playerCarIndex: number): F1MotionData | null {
  const size = 60;
  if (data.length < size || playerCarIndex < 0 || data.length < (playerCarIndex + 1) * size) return null;
  const readCar = (carIndex: number): F1MotionCarData => {
    const o = carIndex * size;
    return { carIndex, posX: data.readFloatLE(o), posY: data.readFloatLE(o + 4), posZ: data.readFloatLE(o + 8), velX: data.readFloatLE(o + 12), velY: data.readFloatLE(o + 16), velZ: data.readFloatLE(o + 20), yaw: data.readFloatLE(o + 48) };
  };
  const allCars = Array.from({ length: Math.min(22, Math.floor(data.length / size)) }, (_, carIndex) => readCar(carIndex));
  const player = allCars[playerCarIndex]!;
  const o = playerCarIndex * size;
  return { ...player, gForceX: data.readFloatLE(o + 36), gForceY: data.readFloatLE(o + 40), gForceZ: data.readFloatLE(o + 44), pitch: data.readFloatLE(o + 52), roll: data.readFloatLE(o + 56), allCars };
}
export function decodeF1Session(data: Buffer): F1SessionData | null {
  if (data.length < 9) return null;
  const samples = data.length >= 127 ? data.readUInt8(126) : 0;
  const rainPercentage = samples > 0 && data.length >= 135 ? data.readUInt8(134) : 0;
  return { weather: data.readUInt8(0), trackTemp: data.readInt8(1), airTemp: data.readInt8(2), totalLaps: data.readUInt8(3), trackLength: data.readUInt16LE(4), sessionType: data.readUInt8(6), trackId: data.readInt8(7), formula: data.readUInt8(8), isSpectating: data.length > 15 && data.readUInt8(15) !== 0, pitSpeedLimit: data.length >= 14 ? data.readUInt8(13) : 0, safetyCarStatus: data.length >= 125 ? data.readUInt8(124) : 0, rainPercentage, sector2LapDistanceStart: 0, sector3LapDistanceStart: 0, pitStopWindowIdealLap: data.length >= 646 ? data.readUInt8(645) : 0, pitStopWindowLatestLap: data.length >= 647 ? data.readUInt8(646) : 0 };
}
export function decodeF1LapData(data: Buffer, playerCarIndex: number): F1LapData | null {
  const size = 57; const allCars: F1LapCarData[] = [];
  for (let i = 0; i < 22 && data.length >= (i + 1) * size; i++) { const o = i * size; allCars.push({ lastLapTime: data.readUInt32LE(o) / 1000, currentLapTime: data.readUInt32LE(o + 4) / 1000, bestLapTime: 0, position: data.readUInt8(o + 32), pitStatus: data.readUInt8(o + 34), numPitStops: data.readUInt8(o + 35), totalDistance: data.readFloatLE(o + 24) }); }
  const o = playerCarIndex * size; if (data.length < o + size) return null;
  const s1 = data.readUInt8(o + 10) * 60000 + data.readUInt16LE(o + 8); const s2 = data.readUInt8(o + 13) * 60000 + data.readUInt16LE(o + 11);
  return { lastLapTime: data.readUInt32LE(o) / 1000, currentLapTime: data.readUInt32LE(o + 4) / 1000, bestLapTime: 0, currentLapNum: data.readUInt8(o + 33), position: data.readUInt8(o + 32), totalDistance: data.readFloatLE(o + 24), lapDistance: data.readFloatLE(o + 20), sector: data.readUInt8(o + 36), sector1Time: s1 / 1000, sector2Time: s2 / 1000, currentLapInvalid: data.readUInt8(o + 37), penalties: data.readUInt8(o + 38), totalWarnings: data.readUInt8(o + 39), cornerCuttingWarnings: data.readUInt8(o + 40), driverStatus: data.readUInt8(o + 44), resultStatus: data.readUInt8(o + 45), pitLaneTimerActive: data.readUInt8(o + 46), pitLaneTimeInLaneInMS: data.readUInt16LE(o + 47), speedTrapFastestSpeed: data.readFloatLE(o + 52), gridPosition: data.readUInt8(o + 43), allCars };
}
export function decodeF1FinalClassification(data: Buffer, playerCarIndex: number): F1FinalClassificationData | null {
  const size = 46; const count = data.length > 0 ? data.readUInt8(0) : 0; const o = 1 + playerCarIndex * size;
  if (playerCarIndex >= count || data.length < o + size) return null;
  return { position: data.readUInt8(o), gridPosition: data.readUInt8(o + 2), numPitStops: data.readUInt8(o + 4), resultStatus: data.readUInt8(o + 5), resultReason: data.readUInt8(o + 6), bestLapTime: data.readUInt32LE(o + 7) / 1000 };
}
export function decodeF1Participants(data: Buffer): F1ParticipantData[] {
  const count = data.readUInt8(0); const body = data.subarray(1); const result: F1ParticipantData[] = [];
  for (let i = 0; i < count && body.length >= (i + 1) * 57; i++) { const o = i * 57; const bytes = body.subarray(o + 7, o + 39); const end = bytes.indexOf(0); result.push({ driverId: body.readUInt8(o + 1), teamId: body.readUInt8(o + 3), name: bytes.subarray(0, end >= 0 ? end : 32).toString("utf8") }); }
  return result;
}
export function decodeF1CarTelemetry(data: Buffer, playerCarIndex: number): F1CarTelemetryData | null {
  const size = 60; const o = playerCarIndex * size; if (data.length < o + size) return null;
  return { speed: data.readUInt16LE(o), throttle: data.readFloatLE(o + 2), steer: data.readFloatLE(o + 6), brake: data.readFloatLE(o + 10), clutch: data.readUInt8(o + 14), gear: data.readInt8(o + 15), rpm: data.readUInt16LE(o + 16), drs: data.readUInt8(o + 18) === 1, tyreTempFL: data.readUInt8(o + 32), tyreTempFR: data.readUInt8(o + 33), tyreTempRL: data.readUInt8(o + 30), tyreTempRR: data.readUInt8(o + 31), tyresInnerTempFL: data.readUInt8(o + 36), tyresInnerTempFR: data.readUInt8(o + 37), tyresInnerTempRL: data.readUInt8(o + 34), tyresInnerTempRR: data.readUInt8(o + 35), brakeTempFL: data.readUInt16LE(o + 26), brakeTempFR: data.readUInt16LE(o + 28), brakeTempRL: data.readUInt16LE(o + 22), brakeTempRR: data.readUInt16LE(o + 24), engineTemperature: data.readUInt16LE(o + 38), tyrePressureFL: data.readFloatLE(o + 48), tyrePressureFR: data.readFloatLE(o + 52), tyrePressureRL: data.readFloatLE(o + 40), tyrePressureRR: data.readFloatLE(o + 44), surfaceTypeFL: data.readUInt8(o + 58), surfaceTypeFR: data.readUInt8(o + 59), surfaceTypeRL: data.readUInt8(o + 56), surfaceTypeRR: data.readUInt8(o + 57), suggestedGear: data.length >= 22 * size + 1 ? data.readInt8(22 * size) : 0 };
}
export function decodeF1CarStatus(data: Buffer, playerCarIndex: number): F1CarStatusData | null {
  const size = 55; const allCars: F1CarStatusEntry[] = [];
  for (let i = 0; i < 22 && data.length >= (i + 1) * size; i++) { const o = i * size; allCars.push({ tyreCompound: data.readUInt8(o + 25), tyreVisualCompound: data.readUInt8(o + 26), tyreAge: data.readUInt8(o + 27) }); }
  const o = playerCarIndex * size; if (data.length < o + size) return null;
  return { tractionControl: data.readUInt8(o), antiLockBrakes: data.readUInt8(o + 1), fuelMix: data.readUInt8(o + 2), frontBrakeBias: data.readUInt8(o + 3), pitLimiterStatus: data.readUInt8(o + 4), fuelRemaining: data.readFloatLE(o + 5), fuelCapacity: data.readFloatLE(o + 9), fuelRemainingLaps: data.readFloatLE(o + 13), maxRPM: data.readUInt16LE(o + 17), idleRPM: data.readUInt16LE(o + 19), maxGears: data.readUInt8(o + 21), drsAllowed: data.readUInt8(o + 22) === 1, drsActivationDistance: data.readUInt16LE(o + 23), actualTyreCompound: data.readUInt8(o + 25), tyreCompound: data.readUInt8(o + 25), tyreVisualCompound: data.readUInt8(o + 26), tyreAge: data.readUInt8(o + 27), vehicleFIAFlags: data.readInt8(o + 28), enginePowerICE: data.readFloatLE(o + 29), enginePowerMGUK: data.readFloatLE(o + 33), ersStore: data.readFloatLE(o + 37), ersDeployMode: data.readUInt8(o + 41), ersDeployedThisLap: data.readFloatLE(o + 50), ersHarvestedThisLap: data.readFloatLE(o + 42) + data.readFloatLE(o + 46), allCars };
}
export function decodeF1CarSetup(data: Buffer, playerCarIndex: number): F1CarSetupData | null {
  const o = playerCarIndex * 50; if (data.length < o + 50) return null;
  return { frontWing: data.readUInt8(o), rearWing: data.readUInt8(o + 1), onThrottle: data.readUInt8(o + 2), offThrottle: data.readUInt8(o + 3), frontCamber: data.readFloatLE(o + 4), rearCamber: data.readFloatLE(o + 8), frontToe: data.readFloatLE(o + 12), rearToe: data.readFloatLE(o + 16), frontSuspension: data.readUInt8(o + 20), rearSuspension: data.readUInt8(o + 21), frontAntiRollBar: data.readUInt8(o + 22), rearAntiRollBar: data.readUInt8(o + 23), frontRideHeight: data.readUInt8(o + 24), rearRideHeight: data.readUInt8(o + 25), brakePressure: data.readUInt8(o + 26), brakeBias: data.readUInt8(o + 27), engineBraking: data.readUInt8(o + 28), rearLeftTyrePressure: data.readFloatLE(o + 29), rearRightTyrePressure: data.readFloatLE(o + 33), frontLeftTyrePressure: data.readFloatLE(o + 37), frontRightTyrePressure: data.readFloatLE(o + 41), fuelLoad: data.readFloatLE(o + 46) };
}
export function decodeF1MotionEx(data: Buffer): F1MotionExData {
  let o = 0; const f = () => { const value = data.readFloatLE(o); o += 4; return value; };
  const suspensionPositionRL = f(), suspensionPositionRR = f(), suspensionPositionFL = f(), suspensionPositionFR = f();
  const suspensionVelocityRL = f(), suspensionVelocityRR = f(), suspensionVelocityFL = f(), suspensionVelocityFR = f(); o += 16;
  const wheelSpeedRL = f(), wheelSpeedRR = f(), wheelSpeedFL = f(), wheelSpeedFR = f();
  const wheelSlipRatioRL = f(), wheelSlipRatioRR = f(), wheelSlipRatioFL = f(), wheelSlipRatioFR = f();
  const wheelSlipAngleRL = f(), wheelSlipAngleRR = f(), wheelSlipAngleFL = f(), wheelSlipAngleFR = f();
  const wheelLatForceRL = f(), wheelLatForceRR = f(), wheelLatForceFL = f(), wheelLatForceFR = f();
  const wheelLongForceRL = f(), wheelLongForceRR = f(), wheelLongForceFL = f(), wheelLongForceFR = f();
  const heightOfCOGAboveGround = f(), localVelocityX = f(), localVelocityY = f(), localVelocityZ = f();
  const angularVelocityX = f(), angularVelocityY = f(), angularVelocityZ = f();
  const angularAccelerationX = f(), angularAccelerationY = f(), angularAccelerationZ = f(), frontWheelsAngle = f();
  const wheelVertForceRL = f(), wheelVertForceRR = f(), wheelVertForceFL = f(), wheelVertForceFR = f();
  const frontAeroHeight = f(), rearAeroHeight = f(), frontRollAngle = f(), rearRollAngle = f(), chassisYaw = f(), chassisPitch = f();
  return { suspensionPositionRL, suspensionPositionRR, suspensionPositionFL, suspensionPositionFR, suspensionVelocityRL, suspensionVelocityRR, suspensionVelocityFL, suspensionVelocityFR, wheelSpeedRL, wheelSpeedRR, wheelSpeedFL, wheelSpeedFR, wheelSlipRatioRL, wheelSlipRatioRR, wheelSlipRatioFL, wheelSlipRatioFR, wheelSlipAngleRL, wheelSlipAngleRR, wheelSlipAngleFL, wheelSlipAngleFR, wheelLatForceRL, wheelLatForceRR, wheelLatForceFL, wheelLatForceFR, wheelLongForceRL, wheelLongForceRR, wheelLongForceFL, wheelLongForceFR, wheelVertForceRL, wheelVertForceRR, wheelVertForceFL, wheelVertForceFR, heightOfCOGAboveGround, localVelocityX, localVelocityY, localVelocityZ, angularVelocityX, angularVelocityY, angularVelocityZ, angularAccelerationX, angularAccelerationY, angularAccelerationZ, frontWheelsAngle, frontAeroHeight, rearAeroHeight, frontRollAngle, rearRollAngle, chassisYaw, chassisPitch };
}
export function decodeF1CarDamage(data: Buffer, playerCarIndex: number): F1CarDamageData | null {
  const o = playerCarIndex * 46; if (data.length < o + 46) return null;
  return { tyreWearFL: data.readFloatLE(o + 8), tyreWearFR: data.readFloatLE(o + 12), tyreWearRL: data.readFloatLE(o), tyreWearRR: data.readFloatLE(o + 4), tyresDamageFL: data.readUInt8(o + 18), tyresDamageFR: data.readUInt8(o + 19), tyresDamageRL: data.readUInt8(o + 16), tyresDamageRR: data.readUInt8(o + 17), brakesDamageFL: data.readUInt8(o + 22), brakesDamageFR: data.readUInt8(o + 23), brakesDamageRL: data.readUInt8(o + 20), brakesDamageRR: data.readUInt8(o + 21), tyreBlistersFL: data.readUInt8(o + 26), tyreBlistsFR: data.readUInt8(o + 27), tyreBlistersRL: data.readUInt8(o + 24), tyreBlistersRR: data.readUInt8(o + 25), frontLeftWingDamage: data.readUInt8(o + 28), frontRightWingDamage: data.readUInt8(o + 29), rearWingDamage: data.readUInt8(o + 30), floorDamage: data.readUInt8(o + 31), diffuserDamage: data.readUInt8(o + 32), sidepodDamage: data.readUInt8(o + 33), drsFault: data.readUInt8(o + 34), ersFault: data.readUInt8(o + 35), gearBoxDamage: data.readUInt8(o + 36), engineDamage: data.readUInt8(o + 37), engineMGUHWear: data.readUInt8(o + 38), engineESWear: data.readUInt8(o + 39), engineCEWear: data.readUInt8(o + 40), engineICEWear: data.readUInt8(o + 41), engineMGUKWear: data.readUInt8(o + 42), engineTCWear: data.readUInt8(o + 43) };
}
export function decodeF1SessionHistory(data: Buffer): F1SessionHistoryData | null {
  if (data.length < 7) return null;
  const carIndex = data.readUInt8(0), count = data.readUInt8(1), bestS1Lap = data.readUInt8(4), bestS2Lap = data.readUInt8(5), bestS3Lap = data.readUInt8(6);
  const size = 14, base = 7; const sector = (o: number, ms: number, min: number) => (data.readUInt8(o + min) * 60000 + data.readUInt16LE(o + ms)) / 1000;
  let bestS1 = 0, bestS2 = 0, bestS3 = 0, bestLapTime = 0, lastS1 = 0, lastS2 = 0, lastS3 = 0, lastLapValidBitFlags = 0;
  if (bestS1Lap > 0 && bestS1Lap <= count) { const o = base + (bestS1Lap - 1) * size; if (data.length >= o + size) bestS1 = sector(o, 4, 6); }
  if (bestS2Lap > 0 && bestS2Lap <= count) { const o = base + (bestS2Lap - 1) * size; if (data.length >= o + size) bestS2 = sector(o, 7, 9); }
  if (bestS3Lap > 0 && bestS3Lap <= count) { const o = base + (bestS3Lap - 1) * size; if (data.length >= o + size) bestS3 = sector(o, 10, 12); }
  const lapSectors: F1SessionHistoryData["lapSectors"] = [];
  if (count > 0) {
    const last = base + (count - 1) * size;
    if (data.length >= last + size) { const ms = data.readUInt32LE(last); lastS1 = sector(last, 4, 6); lastS2 = sector(last, 7, 9); lastS3 = sector(last, 10, 12); lastLapValidBitFlags = data.readUInt8(last + 12); if (ms > 0) bestLapTime = ms / 1000; }
    for (let i = 0; i < count; i++) { const o = base + i * size; if (data.length < o + size) break; const sectors = { lapTime: data.readUInt32LE(o) / 1000, s1: sector(o, 4, 6), s2: sector(o, 7, 9), s3: sector(o, 10, 12), lapValidBitFlags: data.readUInt8(o + 12) }; const lapValidBitFlags = data.readUInt8(o + 12); lapSectors.push({ lapNumber: i + 1, sectors, lapValidBitFlags }); if (sectors.lapTime > 0 && (bestLapTime === 0 || sectors.lapTime < bestLapTime)) bestLapTime = sectors.lapTime; }
  }
  return { carIndex, history: { bestS1, bestS2, bestS3, lastS1, lastS2, lastS3, bestLapTime, lastLapNumber: count, lastLapValidBitFlags }, lapSectors };
}
