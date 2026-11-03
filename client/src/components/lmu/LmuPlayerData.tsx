import type { LmuLiveContextWire } from "@raceiq/shared/telemetry/lmu-context";
import { m } from "@/paraglide/messages";

const CHANNEL_LABELS: Readonly<Record<string, () => string>> = {
  "race.competitor.time-behind-next": m.lmu_channel_timing_gap_place_ahead,
  "race.competitor.time-behind-leader": m.streaming_gap_to_leader,
  "race.competitor.laps-behind-next": () => `${m.lmu_channel_timing_gap_place_ahead()} · ${m.pitwindow_laps()}`,
  "race.competitor.laps-behind-leader": () => `${m.streaming_gap_to_leader()} · ${m.pitwindow_laps()}`,
  "race.competitor.in-pits": m.lmu_channel_race_on_pit_road,
  "race.competitor.pit-state": m.lmu_channel_race_pit_state,
  "identity.competitor.driver-name": m.label_driver,
  "identity.competitor.car-name": m.compare_car_fallback,
  "identity.competitor.vehicle-class": m.track_detail_class,
  "race.competitor.position": m.raceinfo_position,
  "race.competitor.class-position": () => `${m.track_detail_class()} · ${m.raceinfo_position()}`,
  "race.competitor.total-laps": m.pitwindow_laps,
  "race.competitor.current-lap-number": m.compare_lap_label,
  "race.competitor.scoring-time": m.e2e_elapsed_label,
  "race.competitor.best-lap-time": m.sessions_col_best_lap,
  "race.competitor.last-lap-time": () => `${m.label_last()} · ${m.compare_lap_label()}`,
  "race.competitor.best-sector-1": m.lmu_channel_diagnostics_best_sector1,
  "race.competitor.best-sector-2-cumulative": m.lmu_channel_diagnostics_best_sector2,
  "race.competitor.last-sector-1": m.lmu_channel_diagnostics_last_sector1,
  "race.competitor.last-sector-2-cumulative": m.lmu_channel_diagnostics_last_sector2,
  "race.competitor.current-sector-1": m.lmu_channel_diagnostics_current_sector1,
  "race.competitor.current-sector-2-cumulative": m.lmu_channel_diagnostics_current_sector2,
  "race.competitor.pit-stop-count": m.lmu_channel_race_pit_stop_count,
  "race.competitor.count-lap-flag": m.lmu_channel_race_count_lap_flag,
  "race.competitor.lap-distance": m.recap_distance,
  "motion.competitor.speed": m.e2e_speed_label,
  "motion.competitor.position.x": () => `${m.label_position()} · X`,
  "motion.competitor.position.y": () => `${m.label_position()} · Y`,
  "motion.competitor.position.z": () => `${m.label_position()} · Z`,
  "fuel.battery-charge-fraction": m.lmu_channel_fuel_battery_charge_fraction,
  "fuel.state-of-charge": m.lmu_channel_fuel_state_of_charge,
  "fuel.virtual-energy": m.lmu_channel_fuel_virtual_energy,
  "diagnostics.regen-kw": m.lmu_channel_diagnostics_regen_kw,
  "engine.rpm": m.lmu_channel_engine_rpm,
  "engine.water-temperature": m.lmu_channel_engine_water_temperature,
  "engine.oil-temperature": m.lmu_channel_engine_oil_temperature,
  "engine.torque": m.lmu_channel_engine_torque,
  "engine.ignition-starter": m.lmu_channel_engine_ignition_starter,
  "engine.overheating": m.lmu_channel_engine_overheating,
  "hybrid.motor.rpm": m.lmu_channel_hybrid_motor_rpm,
  "hybrid.motor.torque": m.lmu_channel_hybrid_motor_torque,
  "hybrid.motor.temperature": m.lmu_channel_hybrid_motor_temperature,
  "hybrid.motor.water-temperature": m.lmu_channel_hybrid_motor_water_temperature,
  "hybrid.motor.state": m.lmu_channel_hybrid_motor_state,
  "steering.shaft-torque": m.lmu_channel_steering_shaft_torque,
  "weather.rain-intensity": m.lmu_channel_weather_rain_intensity,
  "weather.cloud-coverage": m.lmu_channel_weather_cloud_coverage,
  "weather.cloud-darkness": m.lmu_channel_weather_cloud_darkness,
  "weather.minimum-path-wetness": m.lmu_channel_weather_minimum_path_wetness,
  "weather.maximum-path-wetness": m.lmu_channel_weather_maximum_path_wetness,
  "weather.average-path-wetness": m.lmu_channel_weather_average_path_wetness,
  "weather.wind": m.lmu_channel_weather_wind,
  "weather.track-grip-level": m.lmu_channel_weather_track_grip_level,
  "timing.gap.car-ahead": m.lmu_channel_timing_gap_car_ahead,
  "timing.gap.car-behind": m.lmu_channel_timing_gap_car_behind,
  "timing.gap.place-ahead": m.lmu_channel_timing_gap_place_ahead,
  "timing.gap.place-behind": m.lmu_channel_timing_gap_place_behind,
  "electronics.tc-active": m.lmu_channel_electronics_tc_active,
  "electronics.traction-control-level": m.lmu_channel_electronics_traction_control_level,
  "electronics.abs-active": m.lmu_channel_electronics_abs_active,
  "electronics.abs-level": m.lmu_channel_electronics_abs_level,
  "electronics.motor-map": m.lmu_channel_electronics_motor_map,
  "electronics.tc-cut-level": m.lmu_channel_electronics_tc_cut_level,
  "race.on-pit-road": m.lmu_channel_race_on_pit_road,
  "race.pit-state": m.lmu_channel_race_pit_state,
  "race.scheduled-stops": m.lmu_channel_race_scheduled_stops,
  "race.penalty-count": m.lmu_channel_race_penalty_count,
  "race.pit-stop-count": m.lmu_channel_race_pit_stop_count,
  "race.primary-flag": m.lmu_channel_race_primary_flag,
  "race.under-yellow": m.lmu_channel_race_under_yellow,
  "race.count-lap-flag": m.lmu_channel_race_count_lap_flag,
  "race.in-garage-stall": m.lmu_channel_race_in_garage_stall,
  "race.finish-status": m.lmu_channel_race_finish_status,
  "race.control": m.lmu_channel_race_control,
  "race.yellow-flag-state": m.lmu_channel_race_yellow_flag_state,
  "race.sector-flags": m.lmu_channel_race_sector_flags,
  "race.rear-flap-legal-status": m.lmu_channel_race_rear_flap_legal_status,
  "diagnostics.rear-flap-activated": m.lmu_channel_diagnostics_rear_flap_activated,
  "identity.track-limits-steps": m.lmu_channel_identity_track_limits_steps,
  "diagnostics.best-sector1": m.lmu_channel_diagnostics_best_sector1,
  "diagnostics.best-sector2": m.lmu_channel_diagnostics_best_sector2,
  "diagnostics.last-sector1": m.lmu_channel_diagnostics_last_sector1,
  "diagnostics.last-sector2": m.lmu_channel_diagnostics_last_sector2,
  "diagnostics.current-sector1": m.lmu_channel_diagnostics_current_sector1,
  "diagnostics.current-sector2": m.lmu_channel_diagnostics_current_sector2,
  "control.throttle": m.lmu_channel_control_throttle,
  "control.brake": m.lmu_channel_control_brake,
  "control.steering": m.lmu_channel_control_steering,
  "control.clutch": m.lmu_channel_control_clutch,
  "session.game-phase": m.lmu_channel_session_game_phase,
  "motion.speed-limiter-active": m.lmu_channel_motion_speed_limiter_active,
  "diagnostics.migration": m.lmu_channel_diagnostics_migration,
  "lmu.rest.session.time-scale": m.lmu_channel_lmu_rest_session_time_scale,
  "lmu.rest.session.private-qualifying": m.lmu_channel_lmu_rest_session_private_qualifying,
  "lmu.rest.forecast.practice": m.lmu_channel_lmu_rest_forecast_practice,
  "lmu.rest.forecast.qualify": m.lmu_channel_lmu_rest_forecast_qualify,
  "lmu.rest.forecast.race": m.lmu_channel_lmu_rest_forecast_race,
  "lmu.rest.garage.steering-lock": m.lmu_channel_lmu_rest_garage_steering_lock,
  "lmu.rest.garage.setup": m.lmu_channel_lmu_rest_garage_setup,
  "lmu.rest.condition.aero": m.lmu_channel_lmu_rest_condition_aero,
  "lmu.rest.condition.brakes": m.lmu_channel_lmu_rest_condition_brakes,
  "lmu.rest.condition.suspension": m.lmu_channel_lmu_rest_condition_suspension,
  "lmu.rest.energy.capacity": m.lmu_channel_lmu_rest_energy_capacity,
  "lmu.rest.refill.selection": m.lmu_channel_lmu_rest_refill_selection,
  "lmu.rest.pitstop.estimate": m.lmu_channel_lmu_rest_pitstop_estimate,
  "lmu.rest.repair.estimate": m.lmu_channel_lmu_rest_repair_estimate,
};
const NATIVE_CHANNELS = [
  "fuel.battery-charge-fraction",
  "fuel.state-of-charge",
  "fuel.virtual-energy",
  "diagnostics.regen-kw",
  "engine.rpm",
  "engine.water-temperature",
  "engine.oil-temperature",
  "engine.torque",
  "engine.ignition-starter",
  "engine.overheating",
  "hybrid.motor.rpm",
  "hybrid.motor.torque",
  "hybrid.motor.temperature",
  "hybrid.motor.water-temperature",
  "hybrid.motor.state",
  "steering.shaft-torque",
  "weather.rain-intensity",
  "weather.cloud-coverage",
  "weather.cloud-darkness",
  "weather.minimum-path-wetness",
  "weather.maximum-path-wetness",
  "weather.average-path-wetness",
  "weather.wind",
  "weather.track-grip-level",
  "timing.gap.car-ahead",
  "timing.gap.car-behind",
  "timing.gap.place-ahead",
  "timing.gap.place-behind",
  "electronics.tc-active",
  "electronics.traction-control-level",
  "electronics.abs-active",
  "electronics.abs-level",
  "electronics.motor-map",
  "electronics.tc-cut-level",
  "race.on-pit-road",
  "race.pit-state",
  "race.scheduled-stops",
  "race.penalty-count",
  "race.pit-stop-count",
  "race.primary-flag",
  "race.under-yellow",
  "race.count-lap-flag",
  "race.in-garage-stall",
  "race.finish-status",
  "race.control",
  "race.yellow-flag-state",
  "race.sector-flags",
  "race.rear-flap-legal-status",
  "diagnostics.rear-flap-activated",
  "identity.track-limits-steps",
  "diagnostics.best-sector1",
  "diagnostics.best-sector2",
  "diagnostics.last-sector1",
  "diagnostics.last-sector2",
  "diagnostics.current-sector1",
  "diagnostics.current-sector2",
  "control.throttle",
  "control.brake",
  "control.steering",
  "control.clutch",
  "session.game-phase",
  "motion.speed-limiter-active",
  "diagnostics.migration"
] as const;
const STATE_LABELS: Readonly<Record<string, () => string>> = {
  ok: m.lmu_state_ok, missing: m.lmu_state_missing, stale: m.lmu_state_stale,
  invalid: m.lmu_state_invalid, "not-applicable": m.lmu_state_not_applicable,
  error: m.lmu_state_error, unknown: m.lmu_state_unknown, fresh: m.lmu_state_fresh,
};
export interface LmuPlayerDataProps {
  values: Readonly<Record<string, unknown>>;
  units: Readonly<Record<string, string | null | undefined>>;
  states: Readonly<Record<string, string | undefined>>;
  freshness: Readonly<Record<string, string | undefined>>;
  context?: LmuLiveContextWire;
  referenceTime?: { domain: string; milliseconds: number };
}

export function LmuPlayerData({ values, units, states, freshness, context, referenceTime }: LmuPlayerDataProps) {
  const formatValue = (value: unknown): string => {
    if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    if (typeof value === "boolean") return value ? m.lmu_state_active() : m.lmu_state_inactive();
    return JSON.stringify(value);
  };
  return <section className="border-b border-app-border p-3" data-lmu-native-state>
    <h2 className="mb-2 text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_lmu_native_data()}</h2>
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 @md/workspace:grid-cols-2">
      {NATIVE_CHANNELS.map((semanticId) => {
        const raw = values[semanticId];
        const state = states[semanticId] ?? (raw === undefined || raw === null ? "missing" : "ok");
        const unit = units[semanticId];
        const available = state === "ok" && raw !== null && raw !== undefined;
        const shownUnit = unit === "fraction" ? m.lmu_unit_fraction() : unit === "boolean" || unit === "enum" || unit === "code" ? "" : unit ?? m.lmu_unit_unavailable();
        return <div key={semanticId} data-lmu-channel={semanticId} className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 text-app-text-muted">{CHANNEL_LABELS[semanticId]!()}</span>
          <span className="shrink-0 text-right tabular-nums">{available ? <>{formatValue(raw)} {shownUnit}{freshness[semanticId] && freshness[semanticId] !== "fresh" && <small className="ml-1 text-app-text-muted">{STATE_LABELS[freshness[semanticId]]?.() ?? m.lmu_state_unknown()}</small>}</> : STATE_LABELS[state]?.() ?? m.lmu_state_missing()}</span>
        </div>;
      })}
    </div>
    <div className="mt-3 border-t border-app-border pt-2 text-xs text-app-text-muted" data-lmu-supplemental>
      <h3 className="font-semibold">{m.label_lmu_supplemental()}</h3>
      {!context && <p>{m.lmu_legacy_unavailable()}</p>}
      {context?.supplemental.map((item) => {
        const observation = item.observation;
        const observed = observation.provenance.observedAt;
        const acquired = item.acquiredAt;
        const acquiredAgeMs = referenceTime?.domain === "wall-clock" && acquired.domain === "wall-clock" ? referenceTime.milliseconds - acquired.milliseconds : undefined;
        const observedAgeMs = referenceTime?.domain === "wall-clock" && observed.domain === "wall-clock" ? referenceTime.milliseconds - observed.milliseconds : undefined;
        const condition = item.semanticId.startsWith("lmu.rest.condition.");
        return <details key={item.semanticId} data-lmu-supplemental-channel={item.semanticId} className="mt-2 break-words">
          <summary className="cursor-pointer text-app-text">
            {CHANNEL_LABELS[item.semanticId]!()} · {observation.state === "ok" && observation.value !== null && typeof observation.value !== "object" ? formatValue(observation.value) : STATE_LABELS[observation.state]?.() ?? m.lmu_state_missing()} {observation.unit ?? ""}
            {observation.freshness !== "fresh" && <> · {STATE_LABELS[observation.freshness]?.()}</>}
          </summary>
          {observation.state === "ok" && typeof observation.value === "object" && <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(observation.value, null, 2)}</pre>}
          <p>{item.endpoint} · {item.applicability === "session" ? m.lmu_applicability_session() : m.lmu_applicability_player()}</p>
          <p>{acquiredAgeMs !== undefined && acquiredAgeMs >= 0 ? m.lmu_acquisition_age({ age: String(Math.round(acquiredAgeMs)) }) : m.lmu_age_unavailable()} · {observedAgeMs !== undefined && observedAgeMs >= 0 ? m.lmu_observation_age({ age: String(Math.round(observedAgeMs)) }) : m.lmu_age_unavailable()}</p>
          <p>{m.label_not_current_physics()}{condition && <> · {m.lmu_unverified_scale()}</>}</p>
          {observation.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
        </details>;
      })}
    </div>
    <LmuLiveOpponents context={context ?? null} />
  </section>;
}

export function LmuLiveOpponents({ context }: { context: LmuLiveContextWire | null }) {
  const competitors = context?.competitors?.filter((competitor) => !competitor.isPlayer) ?? [];
  if (competitors.length === 0) return null;
  return <section className="border-b border-app-border p-3" data-lmu-live-opponents>
    <h2 className="mb-2 text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.lmu_live_opponents()}</h2>
    <p className="text-xs text-app-text-muted">{m.compare_opponent_restricted_channels()}</p>
    {competitors.map((competitor) => <details key={`${context?.key.sessionKey}:${competitor.vehicleId}:${competitor.incarnation}`} className="mt-2" data-lmu-competitor={competitor.vehicleId} data-lmu-incarnation={competitor.incarnation}>
      <summary className="cursor-pointer text-sm text-app-text">{String(competitor.channels["identity.competitor.driver-name"]?.value ?? `#${competitor.vehicleId}`)} · #{competitor.vehicleId}/{competitor.incarnation}</summary>
      {[...new Set(Object.values(competitor.channels).flatMap((observation) => observation.limitations))].map((limitation) =>
        <p key={limitation} className="break-words text-xs text-app-text-muted">{limitation}</p>)}
      <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 @md/workspace:grid-cols-2 text-xs">
        {Object.entries(competitor.channels).map(([semanticId, observation]) => <div key={semanticId} className="min-w-0">
          <div className="flex min-w-0 justify-between gap-2">
            <span className="break-words">{CHANNEL_LABELS[semanticId]?.() ?? semanticId}</span>
            <span className="min-w-0 break-all text-right tabular-nums">{observation.state === "ok" && observation.value !== null
              ? <>{typeof observation.value === "number" ? observation.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : JSON.stringify(observation.value)} {observation.unit === "fraction" ? m.lmu_unit_fraction() : observation.unit ?? ""}</>
              : STATE_LABELS[observation.state]?.() ?? m.lmu_state_missing()}
              {observation.freshness !== "fresh" && <> · {STATE_LABELS[observation.freshness]?.() ?? m.lmu_state_unknown()}</>}
            </span>
          </div>
        </div>)}
      </div>
    </details>)}
  </section>;
}
