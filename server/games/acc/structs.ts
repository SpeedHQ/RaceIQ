/**
 * ACC shared memory struct definitions.
 *
 * Offsets computed from official SharedFileOut.h (ACC v1.8.12) with #pragma pack(4).
 * Extended fields beyond the base .h (waterTemp, brakePressure, padLife, discLife)
 * are present in newer ACC versions and verified against live data.
 *
 * wchar_t = 2 bytes on Windows. wchar_t[33] = 66 bytes + 2 bytes padding before
 * the next 4-byte-aligned field.
 */

// --- SPageFilePhysics ---
// Base struct: 712 bytes (from .h)
// Extended: waterTemp..absVibrations add ~88 bytes → ~800 bytes total
export const PHYSICS = {
  SIZE: 800,  // extended; base .h is 712
  packetId:       { offset: 0, type: "i32" },
  gas:            { offset: 4, type: "f32" },
  brake:          { offset: 8, type: "f32" },
  fuel:           { offset: 12, type: "f32" },     // litres remaining
  gear:           { offset: 16, type: "i32" },      // 0=R, 1=N, 2=1st...
  rpms:           { offset: 20, type: "i32" },
  steerAngle:     { offset: 24, type: "f32" },      // -1..1
  speedKmh:       { offset: 28, type: "f32" },
  velocityX:      { offset: 32, type: "f32" },
  velocityY:      { offset: 36, type: "f32" },
  velocityZ:      { offset: 40, type: "f32" },
  accGX:          { offset: 44, type: "f32" },
  accGY:          { offset: 48, type: "f32" },
  accGZ:          { offset: 52, type: "f32" },
  // wheelSlip[4]
  wheelSlipFL:    { offset: 56, type: "f32" },
  wheelSlipFR:    { offset: 60, type: "f32" },
  wheelSlipRL:    { offset: 64, type: "f32" },
  wheelSlipRR:    { offset: 68, type: "f32" },
  // wheelLoad[4] (72-84) — skipped
  // wheelsPressure[4] — PSI
  tyrePressureFL: { offset: 88, type: "f32" },
  tyrePressureFR: { offset: 92, type: "f32" },
  tyrePressureRL: { offset: 96, type: "f32" },
  tyrePressureRR: { offset: 100, type: "f32" },
  // wheelAngularSpeed[4]
  wheelRotFL:     { offset: 104, type: "f32" },
  wheelRotFR:     { offset: 108, type: "f32" },
  wheelRotRL:     { offset: 112, type: "f32" },
  wheelRotRR:     { offset: 116, type: "f32" },
  // tyreWear[4]
  tyreWearFL:     { offset: 120, type: "f32" },
  tyreWearFR:     { offset: 124, type: "f32" },
  tyreWearRL:     { offset: 128, type: "f32" },
  tyreWearRR:     { offset: 132, type: "f32" },
  // tyreDirtyLevel[4] (136-148) — skipped
  // tyreCoreTemperature[4] — °C
  tyreCoreFL:     { offset: 152, type: "f32" },
  tyreCoreFR:     { offset: 156, type: "f32" },
  tyreCoreRL:     { offset: 160, type: "f32" },
  tyreCoreRR:     { offset: 164, type: "f32" },
  // camberRAD[4] (168-180) — skipped
  // suspensionTravel[4] — metres
  suspTravelFL:   { offset: 184, type: "f32" },
  suspTravelFR:   { offset: 188, type: "f32" },
  suspTravelRL:   { offset: 192, type: "f32" },
  suspTravelRR:   { offset: 196, type: "f32" },
  // drs (200) — skipped
  tc:             { offset: 204, type: "f32" },
  heading:        { offset: 208, type: "f32" },
  pitch:          { offset: 212, type: "f32" },
  roll:           { offset: 216, type: "f32" },
  // cgHeight (220) — skipped
  // carDamage[5]
  damFront:       { offset: 224, type: "f32" },
  damRear:        { offset: 228, type: "f32" },
  damLeft:        { offset: 232, type: "f32" },
  damRight:       { offset: 236, type: "f32" },
  damCentre:      { offset: 240, type: "f32" },
  // numberOfTyresOut (244), pitLimiterOn (248)
  abs:            { offset: 252, type: "f32" },
  // kersCharge (256), kersInput (260), autoShifterOn (264)
  // rideHeight[2] (268-272), turboBoost (276), ballast (280), airDensity (284)
  airTemp:        { offset: 288, type: "f32" },
  roadTemp:       { offset: 292, type: "f32" },
  // localAngularVel[3] (296-304) — car-local rates: [0]=pitch (X), [1]=yaw (Y), [2]=roll (Z)
  localAngularVelX: { offset: 296, type: "f32" },
  localAngularVelY: { offset: 300, type: "f32" },
  localAngularVelZ: { offset: 304, type: "f32" },
  // finalFF (308), performanceMeter (312)
  // engineBrake (316), ersRecoveryLevel (320), ersPowerLevel (324)
  // ersHeatCharging (328), ersIsCharging (332), kersCurrentKJ (336)
  // drsAvailable (340), drsEnabled (344)
  // brakeTemp[4] — °C
  brakeTempFL:    { offset: 348, type: "f32" },
  brakeTempFR:    { offset: 352, type: "f32" },
  brakeTempRL:    { offset: 356, type: "f32" },
  brakeTempRR:    { offset: 360, type: "f32" },
  clutch:         { offset: 364, type: "f32" },
  // tyreTempI[4] — inner surface °C
  tyreTempInnerFL: { offset: 368, type: "f32" },
  tyreTempInnerFR: { offset: 372, type: "f32" },
  tyreTempInnerRL: { offset: 376, type: "f32" },
  tyreTempInnerRR: { offset: 380, type: "f32" },
  // tyreTempM[4] — middle surface °C
  tyreTempMiddleFL: { offset: 384, type: "f32" },
  tyreTempMiddleFR: { offset: 388, type: "f32" },
  tyreTempMiddleRL: { offset: 392, type: "f32" },
  tyreTempMiddleRR: { offset: 396, type: "f32" },
  // tyreTempO[4] — outer surface °C
  tyreTempOuterFL: { offset: 400, type: "f32" },
  tyreTempOuterFR: { offset: 404, type: "f32" },
  tyreTempOuterRL: { offset: 408, type: "f32" },
  tyreTempOuterRR: { offset: 412, type: "f32" },
  // isAIControlled (416)
  // tyreContactPoint[4][3] (420-468), tyreContactNormal[4][3] (468-516)
  // tyreContactHeading[4][3] (516-564)
  brakeBias:      { offset: 564, type: "f32" },
  // localVelocity[3] (568-576) — car-local linear velocity: [0]=X (lateral), [1]=Y (vertical), [2]=Z (longitudinal)
  localVelocityX: { offset: 568, type: "f32" },
  localVelocityY: { offset: 572, type: "f32" },
  localVelocityZ: { offset: 576, type: "f32" },
  // P2PActivations (580), P2PStatus (584)
  currentMaxRpm:  { offset: 588, type: "i32" },
  // mz[4] (592-604), fx[4] (608-620), fy[4] (624-636)
  slipRatioFL:    { offset: 640, type: "f32" },
  slipRatioFR:    { offset: 644, type: "f32" },
  slipRatioRL:    { offset: 648, type: "f32" },
  slipRatioRR:    { offset: 652, type: "f32" },
  slipAngleFL:    { offset: 656, type: "f32" },
  slipAngleFR:    { offset: 660, type: "f32" },
  slipAngleRL:    { offset: 664, type: "f32" },
  slipAngleRR:    { offset: 668, type: "f32" },
  // tcinAction (672), absInAction (676), suspensionDamage[4] (680-692)
  // tyreTemp[4] — per-tyre average display temp, °C
  tyreTempFL:     { offset: 696, type: "f32" },
  tyreTempFR:     { offset: 700, type: "f32" },
  tyreTempRL:     { offset: 704, type: "f32" },
  tyreTempRR:     { offset: 708, type: "f32" },
  // --- Extended fields (beyond base .h, present in newer ACC versions) ---
  waterTemp:      { offset: 712, type: "f32" },
  // brakePressure[4] (716-728) — skipped
  // frontBrakeCompound (732), rearBrakeCompound (736)
  padLifeFL:      { offset: 740, type: "f32" },   // mm remaining
  padLifeFR:      { offset: 744, type: "f32" },
  padLifeRL:      { offset: 748, type: "f32" },
  padLifeRR:      { offset: 752, type: "f32" },
  discLifeFL:     { offset: 756, type: "f32" },   // mm remaining
  discLifeFR:     { offset: 760, type: "f32" },
  discLifeRL:     { offset: 764, type: "f32" },
  discLifeRR:     { offset: 768, type: "f32" },
} as const;

// --- SPageFileGraphic ---
// wchar_t[15] = 30 bytes, wchar_t[33] = 66 bytes + 2 pad before next int/float
export const GRAPHICS = {
  SIZE: 1320,
  packetId:         { offset: 0, type: "i32" },
  status:           { offset: 4, type: "i32" },
  session:          { offset: 8, type: "i32" },
  // currentTime wchar_t[15] at 12 (30 bytes), lastTime at 42, bestTime at 72, split at 102
  completedLaps:    { offset: 132, type: "i32" },
  position:         { offset: 136, type: "i32" },
  iCurrentTime:     { offset: 140, type: "i32" },   // ms
  iLastTime:        { offset: 144, type: "i32" },   // ms
  iBestTime:        { offset: 148, type: "i32" },   // ms
  sessionTimeLeft:  { offset: 152, type: "f32" },
  distanceTraveled: { offset: 156, type: "f32" },
  isInPit:          { offset: 160, type: "i32" },
  currentSectorIndex: { offset: 164, type: "i32" },
  lastSectorTime:   { offset: 168, type: "i32" },   // ms
  numberOfLaps:     { offset: 172, type: "i32" },
  // tyreCompound wchar_t[33] at 176 (66 bytes → 242, +2 pad → 244)
  currentTyreCompound: { offset: 176, size: 66, type: "wstring" },
  // replayTimeMultiplier (244)
  normalizedCarPosition: { offset: 248, type: "f32" },
  activeCars:       { offset: 252, type: "i32" },
  // carCoordinates[60][3] at 256 (720 bytes → 976)
  carCoordinatesBase: { offset: 256, type: "f32" }, // stride: 12 bytes per car (3 floats)
  // carID[60] at 976 (240 bytes → 1216)
  carIDBase:        { offset: 976, type: "i32" },   // stride: 4 bytes per car
  playerCarID:      { offset: 1216, type: "i32" },
  // penaltyTime (1220)
  flag:             { offset: 1224, type: "i32" },
  // penalty (1228), idealLineOn (1232)
  isInPitLane:      { offset: 1236, type: "i32" },
  // surfaceGrip (1240), mandatoryPitDone (1244)
  windSpeed:        { offset: 1248, type: "f32" },
  windDirection:    { offset: 1252, type: "f32" },
  isSetupMenuVisible: { offset: 1256, type: "i32" },
  mainDisplayIndex: { offset: 1260, type: "i32" },
  // secondaryDisplayIndex (1264)
  tcGraphics:       { offset: 1268, type: "i32" },
  tcCut:            { offset: 1272, type: "i32" },
  engineMap:        { offset: 1276, type: "i32" },
  absGraphics:      { offset: 1280, type: "i32" },
  fuelXLap:         { offset: 1284, type: "f32" },  // average fuel per lap in litres
  // rainLights (1288), flashingLights (1292), lightsStage (1296)
  // exhaustTemperature (1300), wiperLV (1304)
  // DriverStintTotalTimeLeft (1308), DriverStintTimeLeft (1312)
  rainTyres:        { offset: 1316, type: "i32" },
} as const;

// --- SPageFileStatic ---
// wchar_t[33] = 66 bytes + 2 pad. playerName/Surname/Nick are wchar_t[33] (not [18]).
// No padding between consecutive wchar_t arrays (alignment=2, all even offsets).
// Padding (2 bytes) only before int/float fields when previous wchar_t[33] ends at odd-of-4.
export const STATIC = {
  SIZE: 688,
  // smVersion wchar_t[15] at 0 (30 bytes), acVersion wchar_t[15] at 30 (30 bytes)
  numberOfSessions: { offset: 60, type: "i32" },
  numCars:          { offset: 64, type: "i32" },
  carModel:         { offset: 68, size: 66, type: "wstring" },     // wchar_t[33], ends at 134
  track:            { offset: 134, size: 66, type: "wstring" },    // wchar_t[33], ends at 200
  playerName:       { offset: 200, size: 66, type: "wstring" },    // wchar_t[33], ends at 266
  playerSurname:    { offset: 266, size: 66, type: "wstring" },    // wchar_t[33], ends at 332
  playerNick:       { offset: 332, size: 66, type: "wstring" },    // wchar_t[33], ends at 398
  sectorCount:      { offset: 400, type: "i32" },                  // 398 +2 pad → 400
  // maxTorque (404), maxPower (408)
  maxRpm:           { offset: 412, type: "i32" },
  maxFuel:          { offset: 416, type: "f32" },
  // suspensionMaxTravel[4] (420-432), tyreRadius[4] (436-448)
  // maxTurboBoost (452), deprecated (456-460), penaltiesEnabled (464)
  // aids (468-492), hasDRS (496), hasERS (500), hasKERS (504)
  // kersMaxJ (508), engineBrakeSettingsCount (512), ersPowerControllerCount (516)
  trackSplineLength: { offset: 520, type: "f32" },
  // trackConfiguration wchar_t[33] at 524 (66 bytes → 590, +2 pad → 592)
  // ersMaxJ (592), isTimedRace (596), hasExtraLap (600)
  // carSkin wchar_t[33] at 604 (66 bytes → 670, +2 pad → 672)
  // reversedGridPositions (672)
  pitWindowStart:   { offset: 676, type: "i32" },
  pitWindowEnd:     { offset: 680, type: "i32" },
  // isOnline (684)
  // dryTyresName wchar_t[33] at 688 (in newer ACC), wetTyresName at 754
} as const;

// ACC status enum values
export const AC_STATUS = {
  AC_OFF: 0,
  AC_REPLAY: 1,
  AC_LIVE: 2,
  AC_PAUSE: 3,
} as const;

export const AC_SESSION_TYPE = {
  PRACTICE: 0,
  QUALIFY: 1,
  RACE: 2,
  HOTLAP: 3,
  TIME_ATTACK: 4,
  DRIFT: 5,
  DRAG: 6,
  HOTSTINT: 7,
  HOTSTINT_QUALIFY: 8,
} as const;

export const AC_FLAG = {
  NONE: 0,
  BLUE: 1,
  YELLOW: 2,
  BLACK: 3,
  WHITE: 4,
  CHECKERED: 5,
  PENALTY: 6,
} as const;

export const GRIP_STATUS: Record<number, string> = {
  0: "green",
  1: "fast",
  2: "optimum",
  3: "greasy",
  4: "damp",
  5: "wet",
  6: "flooded",
};

export const FLAG_STATUS: Record<number, string> = {
  [AC_FLAG.NONE]: "none",
  [AC_FLAG.BLUE]: "blue",
  [AC_FLAG.YELLOW]: "yellow",
  [AC_FLAG.BLACK]: "black",
  [AC_FLAG.WHITE]: "white",
  [AC_FLAG.CHECKERED]: "checkered",
  [AC_FLAG.PENALTY]: "penalty",
};
