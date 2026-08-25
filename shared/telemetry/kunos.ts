export interface KunosExtendedData {
  // Tire detail
  tireCompound: string;
  tireCoreTemp: [number, number, number, number];
  tireInnerTemp: [number, number, number, number];
  /**
   * Middle-band surface temp per tire (°C, FL/FR/RL/RR). Read from physics
   * offsets 384-396. With inner/outer this gives the 3-point lateral temp
   * profile the tire symptom module uses for a camber-direction recommendation.
   */
  tireMiddleTemp?: [number, number, number, number];
  tireOuterTemp: [number, number, number, number];
  tireCamber: [number, number, number, number]; // radians, FL/FR/RL/RR
  /**
   * Vertical wheel load per tire (N, FL/FR/RL/RR). Physics offsets 72-84,
   * previously skipped. Recovered retroactively from the raw .bin. Used by the
   * weight-transfer module as a direct load-distribution signal.
   */
  wheelLoad?: [number, number, number, number];
  /**
   * Ride height (m). ACC exposes a 2-element array (front, rear) at offsets
   * 268-272. Used by the weight-transfer module's aero-vs-mechanical split.
   */
  rideHeight?: [number, number];
  /** Center-of-gravity height (m). Physics offset 220, previously skipped. */
  cgHeight?: number;
  tireRadius: [number, number, number, number]; // metres, FL/FR/RL/RR (from STATIC)
  // Per-tire forward-rolling heading unit vector in world space (FL/FR/RL/RR, [x,y,z])
  tireContactHeading: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];

  // Brake detail
  brakePadCompound: number;
  brakePadWear: [number, number, number, number];

  // Electronics — driver settings (level values)
  tc: number;
  tcCut: number;
  abs: number;
  engineMap: number;
  brakeBias: number;
  // Electronics — runtime intervention. tc@204 and abs@252 are the canonical
  // aid floats; slipVibrations@788 and absVibrations@796 are fallbacks that
  // some ACC versions populate instead. `tcIntervention`/`absIntervention`
  // are 1 when any of the sources indicates activity.
  tcIntervention: number;
  absIntervention: number;
  tcRaw: number;
  absRaw: number;
  slipVibrations: number;
  absVibrations: number;

  // Weather
  rainIntensity: number;
  trackGripStatus: string;
  windSpeed: number;
  windDirection: number;
  /**
   * Ambient air / track surface temp (°C), read from SPageFilePhysics
   * (airTemp @288, roadTemp @292 — base-struct fields from the official
   * SharedFileOut.h). Optional: null when the source buffer predates wiring
   * or is truncated before offset 292.
   */
  airTempC?: number | null;
  roadTempC?: number | null;

  // Race state
  flagStatus: string;
  drsAvailable: boolean;
  drsEnabled: boolean;
  pitStatus: string;
  /**
   * Game-reported lap-validity flag. ACC reads graphics offset 1408; AC Evo
   * reads GRAPHICS_EVO.is_valid_lap.
   * true = clean, false = invalidated (track cut / pit speed / etc).
   * null = unavailable in source recording or not meaningful in pit state.
   */
  isValidLap: boolean | null;

  // Fuel
  fuelPerLap: number;

  // Sector timing (native from game)
  currentSectorIndex: number;  // 0=S1, 1=S2, 2=S3
  lastSectorTime: number;       // ms, time of last completed sector

  // Damage
  carDamage: {
    front: number;
    rear: number;
    left: number;
    right: number;
    centre: number;
  };

  /**
   * AC Evo-only extras read from the v0.6 shared-memory pages. Optional so the
   * ACC parser (which shares this type) can omit it. Every field maps 1:1 to a
   * struct field the parser previously ignored — the raw bytes were already in
   * the recorded .bin (full physics/graphics/static pages), so reprocessing old
   * AC Evo sessions surfaces these without a re-record.
   */
  acEvo?: AcEvoExtendedData;
  /** Runtime-only ACC Broadcasting Protocol competitor snapshot fields. */
  broadcastSessionIndex?: number;
  broadcastSessionType?: string;
  broadcastPlayerCarIndex?: number;
  broadcastCarIndex?: readonly number[];
  broadcastDriverId?: readonly string[];
  broadcastDriverName?: readonly string[];
  broadcastCarClassId?: readonly string[];
  broadcastCarClassName?: readonly string[];
  broadcastLapsComplete?: readonly number[];
  broadcastPitStatus?: readonly string[];
  broadcastTrackLocation?: readonly string[];
  broadcastPositionX?: readonly number[];
  broadcastPositionY?: readonly number[];
  broadcastPositionZ?: readonly number[];
  broadcastSpeed?: readonly number[];
  broadcastYaw?: readonly number[];
  broadcastLastLapTime?: readonly number[];
  broadcastLastLapValid?: readonly boolean[];
}

export interface AcEvoExtendedData {
  // Frame identity / staleness — packet IDs increment each shm write.
  physicsPacketId: number;
  graphicsPacketId: number;
  acEvoVersion: string;

  // Session context (STATIC_EVO)
  sessionType: string;          // "time_attack" | "race" | "hot_stint" | "cruise" | "unknown"
  sessionName: string;
  startingGrip: string;         // "green" | "fast" | "optimum" | "unknown"
  isStaticWeather: boolean;
  isTimedRace: boolean;
  isOnline: boolean;
  numberOfSessions: number;

  // Live environment (PHYSICS — distinct from STATIC starting temps)
  airTempC: number;
  roadTempC: number;

  // Live timing (GRAPHICS_EVO — the fields v0.5 froze)
  deltaTimeMs: number;          // live delta vs reference lap
  predictedLapTimeMs: number;
  deltaCurrent: string;         // preformatted from TIMING_STATE (e.g. "-0.234")
  deltaLast: string;
  idealLapTime: string;
  timingIsInvalid: boolean;

  // Session-state block (GRAPHICS_EVO embedded SESSION_STATE)
  sessionTimeLeftMs: number;
  sessionTotalLaps: number;
  sessionCurrentLap: number;
  lapLengthKm: number;

  // Electronics setting levels not already on the acc object
  escLevel: number;
  engineMapLevel: number;
  isDrsOpen: boolean;

  // Engine health (GRAPHICS_EVO)
  clutchPercent: number;        // 0..1
  handbrakePercent: number;     // 0..1
  waterTempC: number;
  oilTempC: number;
  oilPressureBar: number;
  exhaustTempC: number;
  turboBoost: number;
  currentTorque: number;
  currentBhp: number;
  isWrongWay: boolean;

  // Fuel economy (GRAPHICS_EVO)
  fuelLiters: number;
  fuelPercent: number;
  fuelLitersPerLap: number;
  fuelLitersUsed: number;
  lapsPossibleWithFuel: number;
  kmPerFuelLiter: number;
  instantaneousKmPerLiter: number;

  // Brake disc life + tyre middle-tread temps (PHYSICS — pad life & inner/outer
  // already exposed on the packet; these complete the picture)
  brakeDiscLife: [number, number, number, number];  // FL/FR/RL/RR
  tyreMiddleTempC: [number, number, number, number]; // FL/FR/RL/RR

  // Car-frame velocity (PHYSICS localVelocity — distinct from world VelocityXYZ)
  localVelocity: [number, number, number]; // x, y, z

  // Race gaps (GRAPHICS_EVO)
  gapAheadMs: number;
  gapBehindMs: number;

  // Odometry (GRAPHICS_EVO)
  sessionKm: number;
  totalDrivingTimeS: number;

  // Time of day (GRAPHICS_EVO)
  timeOfDayHours: number;
  timeOfDayMinutes: number;
  timeOfDaySeconds: number;
}
