import type { F1CarSetup } from "../../../../shared/telemetry/f1-2025";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";

// Stable keys for section metadata — labels resolved at render time via m.*()
const SECTION_KEYS: Record<string, { titleKey: string; items: Array<{ labelKey: string; value: (s: F1CarSetup) => string | number }> }> = {
  aerodynamics: {
    titleKey: "f1setupmodal_section_aerodynamics",
    items: [
      { labelKey: "f1setupmodal_label_front_wing", value: (s) => s.frontWing },
      { labelKey: "f1setupmodal_label_rear_wing", value: (s) => s.rearWing },
    ],
  },
  transmission: {
    titleKey: "f1setupmodal_section_transmission",
    items: [
      { labelKey: "f1setupmodal_label_differential_on_throttle", value: (s) => `${s.onThrottle}%` },
      { labelKey: "f1setupmodal_label_differential_off_throttle", value: (s) => `${s.offThrottle}%` },
    ],
  },
  suspension_geometry: {
    titleKey: "f1setupmodal_section_suspension_geometry",
    items: [
      { labelKey: "f1setupmodal_label_front_camber", value: (s) => `${s.frontCamber.toFixed(2)}°` },
      { labelKey: "f1setupmodal_label_rear_camber", value: (s) => `${s.rearCamber.toFixed(2)}°` },
      { labelKey: "f1setupmodal_label_front_toe", value: (s) => `${s.frontToe.toFixed(2)}°` },
      { labelKey: "f1setupmodal_label_rear_toe", value: (s) => `${s.rearToe.toFixed(2)}°` },
    ],
  },
  suspension: {
    titleKey: "f1setupmodal_section_suspension",
    items: [
      { labelKey: "f1setupmodal_label_front_suspension", value: (s) => s.frontSuspension },
      { labelKey: "f1setupmodal_label_rear_suspension", value: (s) => s.rearSuspension },
      { labelKey: "f1setupmodal_label_front_anti_roll_bar", value: (s) => s.frontAntiRollBar },
      { labelKey: "f1setupmodal_label_rear_anti_roll_bar", value: (s) => s.rearAntiRollBar },
      { labelKey: "f1setupmodal_label_front_ride_height", value: (s) => s.frontRideHeight },
      { labelKey: "f1setupmodal_label_rear_ride_height", value: (s) => s.rearRideHeight },
    ],
  },
  brakes: {
    titleKey: "f1setupmodal_section_brakes",
    items: [
      { labelKey: "f1setupmodal_label_brake_pressure", value: (s) => `${s.brakePressure}%` },
      { labelKey: "f1setupmodal_label_brake_bias", value: (s) => `${s.brakeBias}%` },
      { labelKey: "f1setupmodal_label_engine_braking", value: (s) => `${s.engineBraking}%` },
    ],
  },
  tires: {
    titleKey: "f1setupmodal_section_tires",
    items: [
      { labelKey: "f1setupmodal_label_front_left_pressure", value: (s) => `${s.frontLeftTyrePressure.toFixed(1)} psi` },
      { labelKey: "f1setupmodal_label_front_right_pressure", value: (s) => `${s.frontRightTyrePressure.toFixed(1)} psi` },
      { labelKey: "f1setupmodal_label_rear_left_pressure", value: (s) => `${s.rearLeftTyrePressure.toFixed(1)} psi` },
      { labelKey: "f1setupmodal_label_rear_right_pressure", value: (s) => `${s.rearRightTyrePressure.toFixed(1)} psi` },
    ],
  },
  fuel: {
    titleKey: "f1setupmodal_section_fuel",
    items: [{ labelKey: "f1setupmodal_label_fuel_load", value: (s) => `${s.fuelLoad.toFixed(1)} kg` }],
  },
};

// Label getter map — resolved at render time
const getLabel: Record<string, () => string> = {
  f1setupmodal_section_aerodynamics: () => m.f1setupmodal_section_aerodynamics(),
  f1setupmodal_section_transmission: () => m.f1setupmodal_section_transmission(),
  f1setupmodal_section_suspension_geometry: () => m.f1setupmodal_section_suspension_geometry(),
  f1setupmodal_section_suspension: () => m.f1setupmodal_section_suspension(),
  f1setupmodal_section_brakes: () => m.f1setupmodal_section_brakes(),
  f1setupmodal_section_tires: () => m.f1setupmodal_section_tires(),
  f1setupmodal_section_fuel: () => m.f1setupmodal_section_fuel(),
  f1setupmodal_label_front_wing: () => m.f1setupmodal_label_front_wing(),
  f1setupmodal_label_rear_wing: () => m.f1setupmodal_label_rear_wing(),
  f1setupmodal_label_differential_on_throttle: () => m.f1setupmodal_label_differential_on_throttle(),
  f1setupmodal_label_differential_off_throttle: () => m.f1setupmodal_label_differential_off_throttle(),
  f1setupmodal_label_front_camber: () => m.f1setupmodal_label_front_camber(),
  f1setupmodal_label_rear_camber: () => m.f1setupmodal_label_rear_camber(),
  f1setupmodal_label_front_toe: () => m.f1setupmodal_label_front_toe(),
  f1setupmodal_label_rear_toe: () => m.f1setupmodal_label_rear_toe(),
  f1setupmodal_label_front_suspension: () => m.f1setupmodal_label_front_suspension(),
  f1setupmodal_label_rear_suspension: () => m.f1setupmodal_label_rear_suspension(),
  f1setupmodal_label_front_anti_roll_bar: () => m.f1setupmodal_label_front_anti_roll_bar(),
  f1setupmodal_label_rear_anti_roll_bar: () => m.f1setupmodal_label_rear_anti_roll_bar(),
  f1setupmodal_label_front_ride_height: () => m.f1setupmodal_label_front_ride_height(),
  f1setupmodal_label_rear_ride_height: () => m.f1setupmodal_label_rear_ride_height(),
  f1setupmodal_label_brake_pressure: () => m.f1setupmodal_label_brake_pressure(),
  f1setupmodal_label_brake_bias: () => m.f1setupmodal_label_brake_bias(),
  f1setupmodal_label_engine_braking: () => m.f1setupmodal_label_engine_braking(),
  f1setupmodal_label_front_left_pressure: () => m.f1setupmodal_label_front_left_pressure(),
  f1setupmodal_label_front_right_pressure: () => m.f1setupmodal_label_front_right_pressure(),
  f1setupmodal_label_rear_left_pressure: () => m.f1setupmodal_label_rear_left_pressure(),
  f1setupmodal_label_rear_right_pressure: () => m.f1setupmodal_label_rear_right_pressure(),
  f1setupmodal_label_fuel_load: () => m.f1setupmodal_label_fuel_load(),
};

export function F1SetupModal({ setup, onClose }: { setup: F1CarSetup; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60">
      <button type="button" aria-label={m.common_close()} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="f1-setup-title"
        className="relative z-10 bg-app-surface border border-app-border rounded-xl w-full max-w-md max-h-[80vh] overflow-y-auto shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border">
          <h2 id="f1-setup-title" className="text-sm font-semibold text-app-text">
            {m.f1setupmodal_section_car_setup()}
          </h2>
          <Button variant="app-ghost" size="app-sm" aria-label={m.common_close()} onClick={onClose}>
            &times;
          </Button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {Object.entries(SECTION_KEYS).map(([key, section]) => (
            <div key={key}>
              <h3 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider mb-2">{getLabel[section.titleKey]()}</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {section.items.map((item) => (
                  <div key={item.labelKey} className="flex justify-between py-0.5">
                    <span className="text-xs text-app-text-muted">{getLabel[item.labelKey]()}</span>
                    <span className="text-xs font-mono text-app-text">{item.value(setup)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
