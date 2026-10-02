import type { Dispatch, SetStateAction } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { GearRatioChart } from "@/components/tune/GearRatioChart";
import type { TuneSettings } from "@/data/tune-catalog";
import { m } from "@/paraglide/messages";
import { NumberField } from "./NumberField";
import { unitLabel } from "./units";
import type { TuneFormCar } from "./useAllCars";

type UpdateSettings = <K extends keyof TuneSettings>(group: K, field: string, value: number) => void;

export function TuneSettingsFields({
  settings,
  isMetric,
  allCars,
  carOrdinal,
  drivetrain,
  updateSettings,
  setSettings,
}: {
  settings: TuneSettings;
  isMetric: boolean;
  allCars: TuneFormCar[];
  carOrdinal: number;
  drivetrain: "rwd" | "fwd" | "awd";
  updateSettings: UpdateSettings;
  setSettings: Dispatch<SetStateAction<TuneSettings>>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 @3xl/workspace:grid-cols-2">
      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_tires()}</h4>
        <NumberField
          label={m.tune_field_front_pressure()}
          value={settings.tires.frontPressure}
          onChange={(v) => updateSettings("tires", "frontPressure", v)}
          step={isMetric ? 0.01 : 0.1}
          unit={unitLabel("tires", isMetric)}
        />
        <NumberField
          label={m.tune_field_rear_pressure()}
          value={settings.tires.rearPressure}
          onChange={(v) => updateSettings("tires", "rearPressure", v)}
          step={isMetric ? 0.01 : 0.1}
          unit={unitLabel("tires", isMetric)}
        />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_gearing()}</h4>
        <NumberField label={m.tune_field_final_drive()} value={settings.gearing.finalDrive} onChange={(v) => updateSettings("gearing", "finalDrive", v)} step={0.01} unit=":1" />
        <NumberField
          label={m.label_top_speed()}
          value={settings.gearing.topSpeedKph ?? Math.round((allCars.find((c) => c.ordinal === carOrdinal)?.specs?.topSpeedMph ?? 0) * 1.60934)}
          onChange={(v) =>
            setSettings((s) => ({
              ...s,
              gearing: { ...s.gearing, topSpeedKph: v },
            }))
          }
          step={1}
          unit="km/h"
        />
        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-app-text-muted">{m.tuneform_gear_ratios()}</span>
            <select
              value={settings.gearing.ratios?.length ?? 6}
              onChange={(e) => {
                const count = parseInt(e.target.value, 10);
                const current = settings.gearing.ratios ?? [];
                const ratios = Array.from({ length: count }, (_, i) => current[i] ?? 3.5 - i * 0.4);
                setSettings((s) => ({
                  ...s,
                  gearing: { ...s.gearing, ratios },
                }));
              }}
              className="bg-app-bg border border-app-border rounded px-1.5 py-0.5 text-xs text-app-text"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {m.tune_gear_count({ count: n })}
                </option>
              ))}
            </select>
          </div>
          {(settings.gearing.ratios ?? []).map((ratio, i) => {
            const topSpeedKph = settings.gearing.topSpeedKph ?? Math.round((allCars.find((c) => c.ordinal === carOrdinal)?.specs?.topSpeedMph ?? 0) * 1.60934);
            const topGearRatio = (settings.gearing.ratios ?? [])[(settings.gearing.ratios ?? []).length - 1];
            const CIRC = topSpeedKph && topGearRatio ? (topSpeedKph * topGearRatio * settings.gearing.finalDrive) / (8000 / 60) / 3.6 : 2.0;
            const gearTopKph = (8000 / 60 / (ratio * settings.gearing.finalDrive)) * CIRC * 3.6;
            return (
              <label key={ratio} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-app-text-muted whitespace-nowrap">{m.tune_gear_number({ number: i + 1 })}</span>
                <div className="flex items-center gap-1">
                  <span className="text-app-caption text-app-text-muted font-mono tabular-nums w-14 text-right">{Math.round(gearTopKph)} km/h</span>
                  <AppInput
                    type="number"
                    value={ratio}
                    step={0.01}
                    onChange={(e) => {
                      const ratios = [...(settings.gearing.ratios ?? [])];
                      ratios[i] = parseFloat(e.target.value) || 0;
                      setSettings((s) => ({
                        ...s,
                        gearing: { ...s.gearing, ratios },
                      }));
                    }}
                    className="w-20 font-mono text-right"
                  />
                  <span className="text-app-caption text-app-text-muted w-8">:1</span>
                </div>
              </label>
            );
          })}
          <GearRatioChart
            ratios={settings.gearing.ratios ?? []}
            finalDrive={settings.gearing.finalDrive}
            topSpeedMph={(settings.gearing.topSpeedKph ?? Math.round((allCars.find((c) => c.ordinal === carOrdinal)?.specs?.topSpeedMph ?? 0) * 1.60934)) / 1.60934}
          />
        </div>
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_alignment()}</h4>
        <NumberField label={m.tune_field_front_camber()} value={settings.alignment.frontCamber} onChange={(v) => updateSettings("alignment", "frontCamber", v)} unit="°" />
        <NumberField label={m.tune_field_rear_camber()} value={settings.alignment.rearCamber} onChange={(v) => updateSettings("alignment", "rearCamber", v)} unit="°" />
        <NumberField label={m.tune_field_front_toe()} value={settings.alignment.frontToe} onChange={(v) => updateSettings("alignment", "frontToe", v)} unit="°" />
        <NumberField label={m.tune_field_rear_toe()} value={settings.alignment.rearToe} onChange={(v) => updateSettings("alignment", "rearToe", v)} unit="°" />
        <NumberField label={m.tune_field_front_caster()} value={settings.alignment.frontCaster ?? 5.0} onChange={(v) => updateSettings("alignment", "frontCaster", v)} unit="°" />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">{m.tune_section_anti_roll_bars()}</h4>
          <span className="text-app-caption text-app-text-muted">{m.tune_soft_to_stiff()}</span>
        </div>
        <NumberField label={m.tune_position_front()} value={settings.antiRollBars.front} onChange={(v) => updateSettings("antiRollBars", "front", v)} />
        <NumberField label={m.tune_position_rear()} value={settings.antiRollBars.rear} onChange={(v) => updateSettings("antiRollBars", "rear", v)} />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_springs()}</h4>
        <NumberField
          label={m.tune_field_front_rate()}
          value={settings.springs.frontRate}
          onChange={(v) => updateSettings("springs", "frontRate", v)}
          step={isMetric ? 0.1 : 1}
          unit={unitLabel("springs", isMetric)}
        />
        <NumberField label={m.tune_field_rear_rate()} value={settings.springs.rearRate} onChange={(v) => updateSettings("springs", "rearRate", v)} step={isMetric ? 0.1 : 1} unit={unitLabel("springs", isMetric)} />
        <NumberField label={m.tune_field_front_height()} value={settings.springs.frontHeight} onChange={(v) => updateSettings("springs", "frontHeight", v)} step={0.1} unit={unitLabel("height", isMetric)} />
        <NumberField label={m.tune_field_rear_height()} value={settings.springs.rearHeight} onChange={(v) => updateSettings("springs", "rearHeight", v)} step={0.1} unit={unitLabel("height", isMetric)} />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent">{m.tune_section_damping()}</h4>
          <span className="text-app-caption text-app-text-muted">{m.tune_soft_to_stiff()}</span>
        </div>
        <NumberField label={m.tune_field_front_bump()} value={settings.damping.frontBump} onChange={(v) => updateSettings("damping", "frontBump", v)} />
        <NumberField label={m.tune_field_rear_bump()} value={settings.damping.rearBump} onChange={(v) => updateSettings("damping", "rearBump", v)} />
        <NumberField label={m.tune_field_front_rebound()} value={settings.damping.frontRebound} onChange={(v) => updateSettings("damping", "frontRebound", v)} />
        <NumberField label={m.tune_field_rear_rebound()} value={settings.damping.rearRebound} onChange={(v) => updateSettings("damping", "rearRebound", v)} />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_roll_center_height()}</h4>
        <NumberField
          label={m.tune_position_front()}
          value={settings.rollCenterHeight.front}
          onChange={(v) =>
            setSettings((s) => ({
              ...s,
              rollCenterHeight: { ...s.rollCenterHeight, front: v },
            }))
          }
          unit={unitLabel("height", isMetric)}
        />
        <NumberField
          label={m.tune_position_rear()}
          value={settings.rollCenterHeight.rear}
          onChange={(v) =>
            setSettings((s) => ({
              ...s,
              rollCenterHeight: { ...s.rollCenterHeight, rear: v },
            }))
          }
          unit={unitLabel("height", isMetric)}
        />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_anti_geometry()}</h4>
        <NumberField
          label={m.tune_field_anti_dive_front()}
          value={settings.antiGeometry.antiDiveFront}
          onChange={(v) =>
            setSettings((s) => ({
              ...s,
              antiGeometry: { ...s.antiGeometry, antiDiveFront: v },
            }))
          }
          unit="%"
        />
        <NumberField
          label={m.tune_field_anti_squat_rear()}
          value={settings.antiGeometry.antiSquatRear}
          onChange={(v) =>
            setSettings((s) => ({
              ...s,
              antiGeometry: { ...s.antiGeometry, antiSquatRear: v },
            }))
          }
          unit="%"
        />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_aero()}</h4>
        <NumberField label={m.tune_field_front_downforce()} value={settings.aero.frontDownforce} onChange={(v) => updateSettings("aero", "frontDownforce", v)} step={1} unit={unitLabel("aero", isMetric)} />
        <NumberField label={m.tune_field_rear_downforce()} value={settings.aero.rearDownforce} onChange={(v) => updateSettings("aero", "rearDownforce", v)} step={1} unit={unitLabel("aero", isMetric)} />
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_differential()}</h4>
        {(drivetrain === "rwd" || drivetrain === "awd") && (
          <>
            <NumberField label={m.tune_field_rear_accel()} value={settings.differential.rearAccel} onChange={(v) => updateSettings("differential", "rearAccel", v)} step={1} unit="%" />
            <NumberField label={m.tune_field_rear_decel()} value={settings.differential.rearDecel} onChange={(v) => updateSettings("differential", "rearDecel", v)} step={1} unit="%" />
          </>
        )}
        {(drivetrain === "fwd" || drivetrain === "awd") && (
          <>
            <NumberField label={m.tune_field_front_accel()} value={settings.differential.frontAccel ?? 0} onChange={(v) => updateSettings("differential", "frontAccel", v)} step={1} unit="%" />
            <NumberField label={m.tune_field_front_decel()} value={settings.differential.frontDecel ?? 0} onChange={(v) => updateSettings("differential", "frontDecel", v)} step={1} unit="%" />
          </>
        )}
        {drivetrain === "awd" && <NumberField label={m.tune_field_center_differential()} value={settings.differential.center ?? 50} onChange={(v) => updateSettings("differential", "center", v)} step={1} unit="%" />}
      </div>

      <div className="rounded-lg bg-app-surface ring-1 ring-app-border p-3 space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-accent mb-2">{m.tune_section_brakes()}</h4>
        <NumberField label={m.tune_field_brake_balance()} value={settings.brakes.balance} onChange={(v) => updateSettings("brakes", "balance", v)} step={1} unit="%" />
        <NumberField label={m.tune_field_brake_pressure()} value={settings.brakes.pressure} onChange={(v) => updateSettings("brakes", "pressure", v)} step={1} unit="%" />
      </div>
    </div>
  );
}
