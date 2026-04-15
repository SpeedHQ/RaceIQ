/**
 * AC Evo v0.6 shared memory struct definitions (SharedFileOut.h, 2026-03-31).
 *
 * Computed offsets assume #pragma pack(4) — each field is placed at the next
 * multiple of min(field_alignment, 4). Sub-structs have fixed sizes per the
 * v0.6 changelog ("inner structures have fixed size"); their internal layouts
 * use far less than the announced size — the rest is reserved padding.
 *
 * Diverges from ACC (server/games/acc/structs.ts):
 *  - SPageFileGraphicEvo is a totally different layout (8 embedded sub-structs)
 *  - SPageFileStaticEvo has a different field order
 *  - Flag and session-type enum values are different
 *  - SPageFilePhysics is structurally the same as ACC's
 */

// --- SPageFilePhysics (matches ACC v1.9 layout — same fields, same order) ---
export const PHYSICS = {
  SIZE: 800,
  packetId:       { offset: 0, type: "i32" },
  gas:            { offset: 4, type: "f32" },
  brake:          { offset: 8, type: "f32" },
  fuel:           { offset: 12, type: "f32" },
  gear:           { offset: 16, type: "i32" },
  rpms:           { offset: 20, type: "i32" },
  steerAngle:     { offset: 24, type: "f32" },
  speedKmh:       { offset: 28, type: "f32" },
  velocityX:      { offset: 32, type: "f32" },
  velocityY:      { offset: 36, type: "f32" },
  velocityZ:      { offset: 40, type: "f32" },
  accGX:          { offset: 44, type: "f32" },
  accGY:          { offset: 48, type: "f32" },
  accGZ:          { offset: 52, type: "f32" },
  wheelSlipFL:    { offset: 56, type: "f32" },
  wheelSlipFR:    { offset: 60, type: "f32" },
  wheelSlipRL:    { offset: 64, type: "f32" },
  wheelSlipRR:    { offset: 68, type: "f32" },
  // wheelLoad[4] @ 72-84
  tyrePressureFL: { offset: 88, type: "f32" },
  tyrePressureFR: { offset: 92, type: "f32" },
  tyrePressureRL: { offset: 96, type: "f32" },
  tyrePressureRR: { offset: 100, type: "f32" },
  wheelRotFL:     { offset: 104, type: "f32" },
  wheelRotFR:     { offset: 108, type: "f32" },
  wheelRotRL:     { offset: 112, type: "f32" },
  wheelRotRR:     { offset: 116, type: "f32" },
  tyreWearFL:     { offset: 120, type: "f32" },
  tyreWearFR:     { offset: 124, type: "f32" },
  tyreWearRL:     { offset: 128, type: "f32" },
  tyreWearRR:     { offset: 132, type: "f32" },
  // tyreDirtyLevel[4] @ 136-148
  tyreCoreFL:     { offset: 152, type: "f32" },
  tyreCoreFR:     { offset: 156, type: "f32" },
  tyreCoreRL:     { offset: 160, type: "f32" },
  tyreCoreRR:     { offset: 164, type: "f32" },
  camberFL:       { offset: 168, type: "f32" },
  camberFR:       { offset: 172, type: "f32" },
  camberRL:       { offset: 176, type: "f32" },
  camberRR:       { offset: 180, type: "f32" },
  suspTravelFL:   { offset: 184, type: "f32" },
  suspTravelFR:   { offset: 188, type: "f32" },
  suspTravelRL:   { offset: 192, type: "f32" },
  suspTravelRR:   { offset: 196, type: "f32" },
  // drs @ 200
  tc:             { offset: 204, type: "f32" },
  heading:        { offset: 208, type: "f32" },
  pitch:          { offset: 212, type: "f32" },
  roll:           { offset: 216, type: "f32" },
  // cgHeight @ 220
  damFront:       { offset: 224, type: "f32" },
  damRear:        { offset: 228, type: "f32" },
  damLeft:        { offset: 232, type: "f32" },
  damRight:       { offset: 236, type: "f32" },
  damCentre:      { offset: 240, type: "f32" },
  // numberOfTyresOut @ 244, pitLimiterOn @ 248
  abs:            { offset: 252, type: "f32" },
  // kersCharge..airDensity @ 256-284
  airTemp:        { offset: 288, type: "f32" },
  roadTemp:       { offset: 292, type: "f32" },
  localAngularVelX: { offset: 296, type: "f32" },
  localAngularVelY: { offset: 300, type: "f32" },
  localAngularVelZ: { offset: 304, type: "f32" },
  // finalFF..drsEnabled @ 308-344
  brakeTempFL:    { offset: 348, type: "f32" },
  brakeTempFR:    { offset: 352, type: "f32" },
  brakeTempRL:    { offset: 356, type: "f32" },
  brakeTempRR:    { offset: 360, type: "f32" },
  clutch:         { offset: 364, type: "f32" },
  tyreTempInnerFL: { offset: 368, type: "f32" },
  tyreTempInnerFR: { offset: 372, type: "f32" },
  tyreTempInnerRL: { offset: 376, type: "f32" },
  tyreTempInnerRR: { offset: 380, type: "f32" },
  tyreTempMiddleFL: { offset: 384, type: "f32" },
  tyreTempMiddleFR: { offset: 388, type: "f32" },
  tyreTempMiddleRL: { offset: 392, type: "f32" },
  tyreTempMiddleRR: { offset: 396, type: "f32" },
  tyreTempOuterFL: { offset: 400, type: "f32" },
  tyreTempOuterFR: { offset: 404, type: "f32" },
  tyreTempOuterRL: { offset: 408, type: "f32" },
  tyreTempOuterRR: { offset: 412, type: "f32" },
  // isAIControlled @ 416, contact[Point|Normal] @ 420-516
  contactHeadingBase: { offset: 516, type: "f32" }, // stride 12 per tire
  brakeBias:      { offset: 564, type: "f32" },
  localVelocityX: { offset: 568, type: "f32" },
  localVelocityY: { offset: 572, type: "f32" },
  localVelocityZ: { offset: 576, type: "f32" },
  // P2P @ 580-584
  currentMaxRpm:  { offset: 588, type: "i32" },
  // mz/fx/fy[4] @ 592-636
  slipRatioFL:    { offset: 640, type: "f32" },
  slipRatioFR:    { offset: 644, type: "f32" },
  slipRatioRL:    { offset: 648, type: "f32" },
  slipRatioRR:    { offset: 652, type: "f32" },
  slipAngleFL:    { offset: 656, type: "f32" },
  slipAngleFR:    { offset: 660, type: "f32" },
  slipAngleRL:    { offset: 664, type: "f32" },
  slipAngleRR:    { offset: 668, type: "f32" },
  // tcInAction/absInAction/suspensionDamage @ 672-692
  tyreTempFL:     { offset: 696, type: "f32" },
  tyreTempFR:     { offset: 700, type: "f32" },
  tyreTempRL:     { offset: 704, type: "f32" },
  tyreTempRR:     { offset: 708, type: "f32" },
  waterTemp:      { offset: 712, type: "f32" },
  // brakePressure[4] @ 716-728, brakeCompound @ 732-736
  padLifeFL:      { offset: 740, type: "f32" },
  padLifeFR:      { offset: 744, type: "f32" },
  padLifeRL:      { offset: 748, type: "f32" },
  padLifeRR:      { offset: 752, type: "f32" },
  discLifeFL:     { offset: 756, type: "f32" },
  discLifeFR:     { offset: 760, type: "f32" },
  discLifeRL:     { offset: 764, type: "f32" },
  discLifeRR:     { offset: 768, type: "f32" },
  // ignitionOn/starterEngineOn/isEngineRunning @ 772-780
  kerbVibration:  { offset: 784, type: "f32" },
  slipVibrations: { offset: 788, type: "f32" },
  gVibrations:    { offset: 792, type: "f32" },
  absVibrations:  { offset: 796, type: "f32" },
} as const;

// =============================================================================
// SMEvoTyreState [256 bytes] — embedded 4× in SPageFileGraphicEvo
// =============================================================================
export const TYRE_STATE_SIZE = 256;
export const TYRE_STATE = {
  slip:                            0,   // f32
  lock:                            4,   // bool (+3 pad)
  tyre_pression:                   8,   // f32 PSI
  tyre_temperature_c:              12,  // f32 average carcass °C
  brake_temperature_c:             16,  // f32 disc °C
  brake_pressure:                  20,  // f32
  tyre_temperature_left:           24,  // f32 inner edge °C
  tyre_temperature_center:         28,  // f32 centre tread °C
  tyre_temperature_right:          32,  // f32 outer edge °C
  // char[33] tyre_compound_front @ 36 (33 bytes, ends at 69)
  // char[33] tyre_compound_rear  @ 69 (33 bytes, ends at 102) — pad to 104
  tyre_normalized_pressure:        104, // f32
  tyre_normalized_temperature_left: 108,
  tyre_normalized_temperature_center: 112,
  tyre_normalized_temperature_right: 116,
  brake_normalized_temperature:    120,
  tyre_normalized_temperature_core: 124,
  // used: 128 bytes; padded to 256
} as const;

// =============================================================================
// SMEvoDamageState [128 bytes]
// =============================================================================
export const DAMAGE_STATE_SIZE = 128;
export const DAMAGE_STATE = {
  damage_front:           0,
  damage_rear:            4,
  damage_left:            8,
  damage_right:           12,
  damage_center:          16,
  damage_suspension_lf:   20,
  damage_suspension_rf:   24,
  damage_suspension_lr:   28,
  damage_suspension_rr:   32,
  // used: 36 bytes; padded to 128
} as const;

// =============================================================================
// SMEvoPitInfo [64 bytes]
// =============================================================================
export const PIT_INFO_SIZE = 64;
export const PIT_INFO = {
  damage:    0,  // i8: -1=skip, 0=done, 1=in-progress
  fuel:      1,
  tyres_lf:  2,
  tyres_rf:  3,
  tyres_lr:  4,
  tyres_rr:  5,
} as const;

// =============================================================================
// SMEvoElectronics [128 bytes]
// =============================================================================
export const ELECTRONICS_SIZE = 128;
export const ELECTRONICS = {
  tc_level:                    0,   // i8
  tc_cut_level:                1,   // i8
  abs_level:                   2,   // i8
  esc_level:                   3,   // i8
  ebb_level:                   4,   // i8 (+3 pad to f32)
  brake_bias:                  8,   // f32
  engine_map_level:            12,  // i8 (+3 pad)
  turbo_level:                 16,  // f32
  ers_deployment_map:          20,  // i8 (+3 pad)
  ers_recharge_map:            24,  // f32
  is_ers_heat_charging_on:     28,  // bool
  is_ers_overtake_mode_on:     29,  // bool
  is_drs_open:                 30,  // bool
  diff_power_level:            31,  // i8
  diff_coast_level:            32,  // i8
  front_bump_damper_level:     33,  // i8
  front_rebound_damper_level:  34,  // i8
  rear_bump_damper_level:      35,  // i8
  rear_rebound_damper_level:   36,  // i8
  is_ignition_on:              37,  // bool
  is_pitlimiter_on:            38,  // bool
  active_performance_mode:     39,  // i8
  // used: 40 bytes; padded to 128
} as const;

// =============================================================================
// SMEvoInstrumentation [128 bytes]
// =============================================================================
export const INSTRUMENTATION_SIZE = 128;
export const INSTRUMENTATION = {
  main_light_stage:               0,   // i8
  special_light_stage:            1,   // i8
  cockpit_light_stage:            2,   // i8
  wiper_level:                    3,   // i8
  rain_lights:                    4,   // bool
  direction_light_left:           5,   // bool
  direction_light_right:          6,   // bool
  flashing_lights:                7,   // bool
  warning_lights:                 8,   // bool
  selected_display_index:         9,   // i8
  display_current_page_index:     10,  // i8[16] (16 bytes — v0.6 widened from 9)
  are_headlights_visible:         26,  // bool
  // used: 27 bytes; padded to 128
} as const;

// =============================================================================
// SMEvoSessionState [256 bytes]
// =============================================================================
export const SESSION_STATE_SIZE = 256;
export const SESSION_STATE = {
  phase_name:                  0,    // char[33] (33 bytes, ends at 33)
  time_left:                   33,   // char[15] (15 bytes, ends at 48)
  time_left_ms:                48,   // i32
  wait_time:                   52,   // char[15] (15 bytes, ends at 67) — pad to 68
  total_lap:                   68,   // i32
  current_lap:                 72,   // i32
  lights_on:                   76,   // i32
  lights_mode:                 80,   // i32
  lap_length_km:               84,   // f32
  end_session_flag:            88,   // i32
  time_to_next_session:        92,   // char[15] (ends at 107) — pad to 108
  disconnected_from_server:    108,  // bool
  restart_season_enabled:      109,  // bool
  ui_enable_drive:             110,  // bool
  ui_enable_setup:             111,  // bool
  is_ready_to_next_blinking:   112,  // bool
  show_waiting_for_players:    113,  // bool
  // used: 114 bytes; padded to 256
} as const;

// =============================================================================
// SMEvoTimingState [256 bytes]
// =============================================================================
export const TIMING_STATE_SIZE = 256;
export const TIMING_STATE = {
  current_laptime:    0,    // char[15] (ends at 15)
  delta_current:      15,   // char[15] (ends at 30) — pad to 32
  delta_current_p:    32,   // i32
  last_laptime:       36,   // char[15] (ends at 51)
  delta_last:         51,   // char[15] (ends at 66) — pad to 68
  delta_last_p:       68,   // i32
  best_laptime:       72,   // char[15] (ends at 87)
  ideal_laptime:      87,   // char[15] (ends at 102)
  total_time:         102,  // char[15] (ends at 117)
  is_invalid:         117,  // bool
  // used: 118 bytes; padded to 256
} as const;

// =============================================================================
// SMEvoAssistsState [64 bytes]
// =============================================================================
export const ASSISTS_STATE_SIZE = 64;
export const ASSISTS_STATE = {
  auto_gear:                  0,   // u8
  auto_blip:                  1,   // u8
  auto_clutch:                2,   // u8
  auto_clutch_on_start:       3,   // u8
  manual_ignition_e_start:    4,   // u8
  auto_pit_limiter:           5,   // u8
  standing_start_assist:      6,   // u8 (+1 pad to f32)
  auto_steer:                 8,   // f32
  arcade_stability_control:   12,  // f32
  // used: 16 bytes; padded to 64
} as const;

// =============================================================================
// SPageFileGraphicEvo — main HUD page
// =============================================================================
const TYRE_LF_BASE = 220;
const TYRE_RF_BASE = TYRE_LF_BASE + TYRE_STATE_SIZE; // 476
const TYRE_LR_BASE = TYRE_RF_BASE + TYRE_STATE_SIZE; // 732
const TYRE_RR_BASE = TYRE_LR_BASE + TYRE_STATE_SIZE; // 988
const POST_TYRES = TYRE_RR_BASE + TYRE_STATE_SIZE;   // 1244

const DAMAGE_BASE = 1260;                                  // POST_TYRES + 16 floats (npos..control_lock_time)
const POST_DAMAGE = DAMAGE_BASE + DAMAGE_STATE_SIZE;       // 1388
const PIT_INFO_BASE = POST_DAMAGE + 4;                     // 1392 (after car_location enum)
const POST_PIT = PIT_INFO_BASE + PIT_INFO_SIZE;            // 1456

// 8 floats (fuel/battery/instantaneous/gear_rpm_window) — 32 bytes
const INSTRUMENTATION_BASE = POST_PIT + 32;                // 1488
const INSTRUMENTATION_MIN_BASE = INSTRUMENTATION_BASE + INSTRUMENTATION_SIZE; // 1616
const INSTRUMENTATION_MAX_BASE = INSTRUMENTATION_MIN_BASE + INSTRUMENTATION_SIZE; // 1744
const ELECTRONICS_BASE = INSTRUMENTATION_MAX_BASE + INSTRUMENTATION_SIZE; // 1872
const ELECTRONICS_MIN_BASE = ELECTRONICS_BASE + ELECTRONICS_SIZE; // 2000
const ELECTRONICS_MAX_BASE = ELECTRONICS_MIN_BASE + ELECTRONICS_SIZE; // 2128
const ELECTRONICS_MOD_BASE = ELECTRONICS_MAX_BASE + ELECTRONICS_SIZE; // 2256
const POST_ELECTRONICS = ELECTRONICS_MOD_BASE + ELECTRONICS_SIZE; // 2384

const SESSION_STATE_BASE = 2476;                           // after total_lap_count..race_cut_current_delta block
const TIMING_STATE_BASE = SESSION_STATE_BASE + SESSION_STATE_SIZE; // 2732

const POST_TIMING = TIMING_STATE_BASE + TIMING_STATE_SIZE; // 2988
const CAR_COORDS_BASE = 3124;                              // 8 player ints + char[33]×3 + 3 bools, padded
const POST_COORDS = CAR_COORDS_BASE + 60 * 12;             // 3844

const ASSISTS_BASE = 3864;                                 // gap_ahead/behind + active_cars(+pad) + 2 floats
const POST_ASSISTS = ASSISTS_BASE + ASSISTS_STATE_SIZE;    // 3928

export const GRAPHICS_EVO = {
  // Last field use_single_compound (bool) ends at 3937. Aligned up to 8
  // (largest member is uint64) = 3944. Stays well within one 4KB page.
  SIZE: 3944,

  // --- Header ---
  packetId:                       { offset: 0, type: "i32" },
  status:                         { offset: 4, type: "i32" }, // ACEVO_STATUS enum

  // uint64 IDs (8-byte aligned at offset 8)
  focused_car_id_a:               { offset: 8, type: "u64" },
  focused_car_id_b:               { offset: 16, type: "u64" },
  player_car_id_a:                { offset: 24, type: "u64" },
  player_car_id_b:                { offset: 32, type: "u64" },

  // --- Engine / dash flags ---
  rpm:                            { offset: 40, type: "u16" },
  is_rpm_limiter_on:              { offset: 42, type: "bool" },
  is_change_up_rpm:               { offset: 43, type: "bool" },
  is_change_down_rpm:             { offset: 44, type: "bool" },
  tc_active:                      { offset: 45, type: "bool" },
  abs_active:                     { offset: 46, type: "bool" },
  esc_active:                     { offset: 47, type: "bool" },
  launch_active:                  { offset: 48, type: "bool" },
  is_ignition_on:                 { offset: 49, type: "bool" },
  is_engine_running:              { offset: 50, type: "bool" },
  kers_is_charging:               { offset: 51, type: "bool" },
  is_wrong_way:                   { offset: 52, type: "bool" },
  is_drs_available:               { offset: 53, type: "bool" },
  battery_is_charging:            { offset: 54, type: "bool" },
  is_max_kj_per_lap_reached:      { offset: 55, type: "bool" },
  is_max_charge_kj_per_lap_reached: { offset: 56, type: "bool" },

  // --- Speed / inputs (shorts at 58, 60, 62; floats from 64) ---
  display_speed_kmh:              { offset: 58, type: "i16" },
  display_speed_mph:              { offset: 60, type: "i16" },
  display_speed_ms:               { offset: 62, type: "i16" },
  pitspeeding_delta:              { offset: 64, type: "f32" },
  gear_int:                       { offset: 68, type: "i16" }, // 0=R, 1=N, 2+=forward
  rpm_percent:                    { offset: 72, type: "f32" },
  gas_percent:                    { offset: 76, type: "f32" },
  brake_percent:                  { offset: 80, type: "f32" },
  handbrake_percent:              { offset: 84, type: "f32" },
  clutch_percent:                 { offset: 88, type: "f32" },
  steering_percent:               { offset: 92, type: "f32" }, // -1..1
  ffb_strength:                   { offset: 96, type: "f32" },
  car_ffb_mupliplier:             { offset: 100, type: "f32" },

  // --- Engine instruments ---
  water_temperature_percent:      { offset: 104, type: "f32" },
  water_pressure_bar:             { offset: 108, type: "f32" },
  fuel_pressure_bar:              { offset: 112, type: "f32" },
  water_temperature_c:            { offset: 116, type: "i8" },
  air_temperature_c:              { offset: 117, type: "i8" },
  oil_temperature_c:              { offset: 120, type: "f32" },
  oil_pressure_bar:               { offset: 124, type: "f32" },
  exhaust_temperature_c:          { offset: 128, type: "f32" },

  // --- G-forces / boost ---
  g_forces_x:                     { offset: 132, type: "f32" },
  g_forces_y:                     { offset: 136, type: "f32" },
  g_forces_z:                     { offset: 140, type: "f32" },
  turbo_boost:                    { offset: 144, type: "f32" },
  turbo_boost_level:              { offset: 148, type: "f32" },
  turbo_boost_perc:               { offset: 152, type: "f32" },

  // --- Steering / odometry ---
  steer_degrees:                  { offset: 156, type: "i32" },
  current_km:                     { offset: 160, type: "f32" }, // distance this session
  total_km:                       { offset: 164, type: "u32" },
  total_driving_time_s:           { offset: 168, type: "u32" },

  // --- Time of day ---
  time_of_day_hours:              { offset: 172, type: "i32" },
  time_of_day_minutes:            { offset: 176, type: "i32" },
  time_of_day_seconds:            { offset: 180, type: "i32" },

  // --- Lap timing (the fields v0.5 left frozen) ---
  delta_time_ms:                  { offset: 184, type: "i32" },
  current_lap_time_ms:            { offset: 188, type: "i32" }, // ★ live lap time
  predicted_lap_time_ms:          { offset: 192, type: "i32" },

  // --- Fuel ---
  fuel_liter_current_quantity:    { offset: 196, type: "f32" },
  fuel_liter_current_quantity_percent: { offset: 200, type: "f32" },
  fuel_liter_per_km:              { offset: 204, type: "f32" },
  km_per_fuel_liter:              { offset: 208, type: "f32" },
  current_torque:                 { offset: 212, type: "f32" },
  current_bhp:                    { offset: 216, type: "i32" },

  // --- Embedded tyre states (4× 256 bytes = 1024) ---
  tyre_lf_base:                   { offset: TYRE_LF_BASE, type: "struct" },
  tyre_rf_base:                   { offset: TYRE_RF_BASE, type: "struct" },
  tyre_lr_base:                   { offset: TYRE_LR_BASE, type: "struct" },
  tyre_rr_base:                   { offset: TYRE_RR_BASE, type: "struct" },

  // --- Track position & energy ---
  npos:                           { offset: POST_TYRES, type: "f32" },        // 1244
  kers_charge_perc:               { offset: POST_TYRES + 4, type: "f32" },
  kers_current_perc:              { offset: POST_TYRES + 8, type: "f32" },
  control_lock_time:              { offset: POST_TYRES + 12, type: "f32" },

  // --- Damage / location / pit ---
  car_damage_base:                { offset: DAMAGE_BASE, type: "struct" },     // 1260
  car_location:                   { offset: POST_DAMAGE, type: "i32" },        // 1388 — ACEVO_CAR_LOCATION enum
  pit_info_base:                  { offset: PIT_INFO_BASE, type: "struct" },   // 1392

  // --- Fuel telemetry ---
  fuel_liter_used:                { offset: POST_PIT, type: "f32" },           // 1456
  fuel_liter_per_lap:             { offset: POST_PIT + 4, type: "f32" },
  laps_possible_with_fuel:        { offset: POST_PIT + 8, type: "f32" },
  battery_temperature:            { offset: POST_PIT + 12, type: "f32" },
  battery_voltage:                { offset: POST_PIT + 16, type: "f32" },
  instantaneous_fuel_liter_per_km: { offset: POST_PIT + 20, type: "f32" },
  instantaneous_km_per_fuel_liter: { offset: POST_PIT + 24, type: "f32" },
  gear_rpm_window:                { offset: POST_PIT + 28, type: "f32" },

  // --- Instrumentation triplet (current/min/max) — 3× 128 bytes ---
  instrumentation_base:           { offset: INSTRUMENTATION_BASE, type: "struct" },
  instrumentation_min_base:       { offset: INSTRUMENTATION_MIN_BASE, type: "struct" },
  instrumentation_max_base:       { offset: INSTRUMENTATION_MAX_BASE, type: "struct" },

  // --- Electronics quartet (current/min/max/modifiable) — 4× 128 bytes ---
  electronics_base:               { offset: ELECTRONICS_BASE, type: "struct" },
  electronics_min_base:           { offset: ELECTRONICS_MIN_BASE, type: "struct" },
  electronics_max_base:           { offset: ELECTRONICS_MAX_BASE, type: "struct" },
  electronics_is_modifiable_base: { offset: ELECTRONICS_MOD_BASE, type: "struct" },

  // --- Lap counters / position ---
  total_lap_count:                { offset: POST_ELECTRONICS, type: "i32" },         // 2384 ★ completed laps
  current_pos:                    { offset: POST_ELECTRONICS + 4, type: "u32" },      // 2388
  total_drivers:                  { offset: POST_ELECTRONICS + 8, type: "u32" },      // 2392
  last_laptime_ms:                { offset: POST_ELECTRONICS + 12, type: "i32" },     // 2396 ★
  best_laptime_ms:                { offset: POST_ELECTRONICS + 16, type: "i32" },     // 2400 ★

  // --- Flags / engine info ---
  flag:                           { offset: POST_ELECTRONICS + 20, type: "i32" },     // 2404 — ACEVO_FLAG_TYPE
  global_flag:                    { offset: POST_ELECTRONICS + 24, type: "i32" },     // 2408
  max_gears:                      { offset: POST_ELECTRONICS + 28, type: "u32" },     // 2412
  engine_type:                    { offset: POST_ELECTRONICS + 32, type: "i32" },     // 2416 — ACEVO_ENGINE_TYPE
  has_kers:                       { offset: POST_ELECTRONICS + 36, type: "bool" },    // 2420
  is_last_lap:                    { offset: POST_ELECTRONICS + 37, type: "bool" },    // 2421
  performance_mode_name:          { offset: POST_ELECTRONICS + 38, size: 33, type: "cstring" }, // 2422 (ends 2455 → pad 2456)
  diff_coast_raw_value:           { offset: POST_ELECTRONICS + 72, type: "f32" },     // 2456
  diff_power_raw_value:           { offset: POST_ELECTRONICS + 76, type: "f32" },     // 2460
  race_cut_gained_time_ms:        { offset: POST_ELECTRONICS + 80, type: "i32" },     // 2464
  distance_to_deadline:           { offset: POST_ELECTRONICS + 84, type: "i32" },     // 2468
  race_cut_current_delta:         { offset: POST_ELECTRONICS + 88, type: "f32" },     // 2472

  // --- Embedded session/timing states ---
  session_state_base:             { offset: SESSION_STATE_BASE, type: "struct" },     // 2476
  timing_state_base:              { offset: TIMING_STATE_BASE, type: "struct" },      // 2732

  // --- Network / perf ---
  player_ping:                    { offset: POST_TIMING, type: "i32" },                // 2988
  player_latency:                 { offset: POST_TIMING + 4, type: "i32" },
  player_cpu_usage:               { offset: POST_TIMING + 8, type: "i32" },
  player_cpu_usage_avg:           { offset: POST_TIMING + 12, type: "i32" },
  player_qos:                     { offset: POST_TIMING + 16, type: "i32" },
  player_qos_avg:                 { offset: POST_TIMING + 20, type: "i32" },
  player_fps:                     { offset: POST_TIMING + 24, type: "i32" },
  player_fps_avg:                 { offset: POST_TIMING + 28, type: "i32" },

  // --- Driver / car identity ---
  driver_name:                    { offset: POST_TIMING + 32, size: 33, type: "cstring" }, // 3020
  driver_surname:                 { offset: POST_TIMING + 65, size: 33, type: "cstring" }, // 3053
  car_model:                      { offset: POST_TIMING + 98, size: 33, type: "cstring" }, // 3086

  is_in_pit_box:                  { offset: POST_TIMING + 131, type: "bool" }, // 3119
  is_in_pit_lane:                 { offset: POST_TIMING + 132, type: "bool" }, // 3120
  is_valid_lap:                   { offset: POST_TIMING + 133, type: "bool" }, // 3121

  // --- Car coordinates [60][3] ---
  car_coordinates_base:           { offset: CAR_COORDS_BASE, type: "f32" }, // stride 12 per car

  // --- Race gaps ---
  gap_ahead:                      { offset: POST_COORDS, type: "f32" },          // 3844
  gap_behind:                     { offset: POST_COORDS + 4, type: "f32" },      // 3848
  active_cars:                    { offset: POST_COORDS + 8, type: "u8" },       // 3852

  // --- Fuel projection ---
  fuel_per_lap:                   { offset: POST_COORDS + 12, type: "f32" },     // 3856
  fuel_estimated_laps:            { offset: POST_COORDS + 16, type: "f32" },     // 3860

  // --- Driver assists ---
  assists_state_base:             { offset: ASSISTS_BASE, type: "struct" },      // 3864

  // --- Tail ---
  max_fuel:                       { offset: POST_ASSISTS, type: "f32" },         // 3928
  max_turbo_boost:                { offset: POST_ASSISTS + 4, type: "f32" },     // 3932
  use_single_compound:            { offset: POST_ASSISTS + 8, type: "bool" },    // 3936
} as const;

// =============================================================================
// SPageFileStaticEvo
// =============================================================================
export const STATIC_EVO = {
  SIZE: 256,
  sm_version:                     { offset: 0, size: 15, type: "cstring" },   // char[15]
  ac_evo_version:                 { offset: 15, size: 15, type: "cstring" },  // char[15] (ends 30 → pad 32)
  session:                        { offset: 32, type: "i32" },                // ACEVO_SESSION_TYPE enum (signed)
  session_name:                   { offset: 36, size: 33, type: "cstring" },  // char[33] (ends 69)
  event_id:                       { offset: 69, type: "u8" },
  session_id:                     { offset: 70, type: "u8" },                 // (ends 71 → pad 72)
  starting_grip:                  { offset: 72, type: "i32" },                // ACEVO_STARTING_GRIP enum
  starting_ambient_temperature_c: { offset: 76, type: "f32" },
  starting_ground_temperature_c:  { offset: 80, type: "f32" },
  is_static_weather:              { offset: 84, type: "bool" },
  is_timed_race:                  { offset: 85, type: "bool" },
  is_online:                      { offset: 86, type: "bool" },               // (ends 87 → pad 88)
  number_of_sessions:             { offset: 88, type: "i32" },
  nation:                         { offset: 92, size: 33, type: "cstring" },  // ends 125 → pad 128
  longitude:                      { offset: 128, type: "f32" },
  latitude:                       { offset: 132, type: "f32" },
  track:                          { offset: 136, size: 33, type: "cstring" }, // ends 169
  track_configuration:            { offset: 169, size: 33, type: "cstring" }, // ends 202 → pad 204
  track_length_m:                 { offset: 204, type: "f32" },
} as const;

// =============================================================================
// Enums
// =============================================================================

// ACEVO_STATUS
export const ACEVO_STATUS = {
  AC_OFF: 0,
  AC_REPLAY: 1,
  AC_LIVE: 2,
  AC_PAUSE: 3,
} as const;

// ACEVO_SESSION_TYPE — note: signed, AC_UNKNOWN = -1
export const ACEVO_SESSION_TYPE = {
  AC_UNKNOWN: -1,
  AC_TIME_ATTACK: 0,
  AC_RACE: 1,
  AC_HOT_STINT: 2,
  AC_CRUISE: 3,
} as const;

// ACEVO_FLAG_TYPE — totally different mapping from ACC v1.x
export const ACEVO_FLAG_TYPE = {
  AC_NO_FLAG: 0,
  AC_WHITE_FLAG: 1,
  AC_GREEN_FLAG: 2,
  AC_RED_FLAG: 3,
  AC_BLUE_FLAG: 4,
  AC_YELLOW_FLAG: 5,
  AC_BLACK_FLAG: 6,
  AC_BLACK_WHITE_FLAG: 7,
  AC_CHECKERED_FLAG: 8,
  AC_ORANGE_CIRCLE_FLAG: 9,
  AC_RED_YELLOW_STRIPES_FLAG: 10,
} as const;

export const ACEVO_FLAG_NAMES: Record<number, string> = {
  [ACEVO_FLAG_TYPE.AC_NO_FLAG]: "none",
  [ACEVO_FLAG_TYPE.AC_WHITE_FLAG]: "white",
  [ACEVO_FLAG_TYPE.AC_GREEN_FLAG]: "green",
  [ACEVO_FLAG_TYPE.AC_RED_FLAG]: "red",
  [ACEVO_FLAG_TYPE.AC_BLUE_FLAG]: "blue",
  [ACEVO_FLAG_TYPE.AC_YELLOW_FLAG]: "yellow",
  [ACEVO_FLAG_TYPE.AC_BLACK_FLAG]: "black",
  [ACEVO_FLAG_TYPE.AC_BLACK_WHITE_FLAG]: "black_white",
  [ACEVO_FLAG_TYPE.AC_CHECKERED_FLAG]: "checkered",
  [ACEVO_FLAG_TYPE.AC_ORANGE_CIRCLE_FLAG]: "orange_circle",
  [ACEVO_FLAG_TYPE.AC_RED_YELLOW_STRIPES_FLAG]: "red_yellow_stripes",
};

// ACEVO_CAR_LOCATION
export const ACEVO_CAR_LOCATION = {
  ACEVO_UNASSIGNED: 0,
  ACEVO_PITLANE: 1,
  ACEVO_PITENTRY: 2,
  ACEVO_PITEXIT: 3,
  ACEVO_TRACK: 4,
} as const;

// ACEVO_ENGINE_TYPE
export const ACEVO_ENGINE_TYPE = {
  ACEVO_INTERNAL_COMBUSTION: 0,
  ACEVO_ELECTRIC_MOTOR: 1,
} as const;

// ACEVO_STARTING_GRIP
export const ACEVO_STARTING_GRIP = {
  ACEVO_GREEN: 0,
  ACEVO_FAST: 1,
  ACEVO_OPTIMUM: 2,
} as const;
