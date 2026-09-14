import { useUnits } from "@/hooks/useUnits";
import { type BrakeTempThresholds, brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";

const PAD_NEW_MM = 29; // ACC: pads start at 29mm when new

export interface WheelData {
  tempC?: number; // always °C when available — caller normalises
  coreTempC?: number; // optional core temperature in °C
  temperatureBandsC?: { inner: number; middle: number; outer: number }; // optional inner/middle/outer carcass temperatures in °C
  wear?: number; // 0 (new) → 1 (gone) when available
  brakeTemp?: number; // °C, optional
  brakePadMm?: number; // mm remaining (ACC: new = 29mm), drives pad height
  pressure?: number; // psi, optional
}

type CornerSet<T> = Record<"FL" | "FR" | "RL" | "RR", T>;

interface TireGridProps {
  /** Per-corner data. Either pass `corners` (one object, four corners) or
   *  the individual fl/fr/rl/rr props — not both. */
  corners?: CornerSet<WheelData>;
  fl?: WheelData;
  fr?: WheelData;
  rl?: WheelData;
  rr?: WheelData;
  healthThresholds: { green: number; yellow: number }; // fractions 0–1
  tempThresholds: { blue: number; orange: number; red: number }; // °C
  pressureOptimal?: { min: number; max: number }; // psi
  brakeTempThresholds?: BrakeTempThresholds;
  compound?: string;
  freshnessNote?: string;
  temperatureAvailable?: boolean;
  healthAvailable?: boolean;
}

export function TireGrid({
  corners,
  fl,
  fr,
  rl,
  rr,
  healthThresholds,
  tempThresholds,
  pressureOptimal,
  brakeTempThresholds,
  compound,
  freshnessNote,
  temperatureAvailable = true,
  healthAvailable = true,
}: TireGridProps) {
  const flData = corners?.FL ?? fl!;
  const frData = corners?.FR ?? fr!;
  const rlData = corners?.RL ?? rl!;
  const rrData = corners?.RR ?? rr!;
  const units = useUnits();
  const normalizedTempThresholds = {
    cold: tempThresholds.blue,
    warm: tempThresholds.orange,
    hot: tempThresholds.red,
  };

  const wheels = [
    { label: "FL", ...flData },
    { label: "FR", ...frData },
    { label: "RL", ...rlData },
    { label: "RR", ...rrData },
  ];

  const hasBrake = wheels.some((wheel) => wheel.brakeTemp !== undefined);
  const hasPressure = wheels.some((wheel) => wheel.pressure !== undefined);

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_tires()}</h2>
        <div className="flex items-center gap-2">
          {freshnessNote && <span className="text-app-caption text-app-text-dim">{freshnessNote}</span>}
          {compound && (
            <span className="tire-compound-badge text-xs font-bold uppercase px-2 py-0.5 rounded" data-tire-compound={compound.toLowerCase()}>
              {compound}
            </span>
          )}
        </div>
      </div>
      <div className="p-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {wheels.map((wheel) => {
            const wear = wheel.wear;
            const tempC = wheel.tempC;
            const coreTempC = wheel.coreTempC;
            const showsHealth = healthAvailable && wear !== undefined;
            const showsTemperature = temperatureAvailable && tempC !== undefined;
            const hasCoreTemperature = showsTemperature && coreTempC !== undefined && Number.isFinite(coreTempC);
            const health = showsHealth ? Math.max(0, (1 - wear) * 100) : 0;
            const healthColor = showsHealth ? tireHealthColor(wear, healthThresholds) : "var(--status-unavailable)";
            const temperatureColor = showsTemperature ? tireTempColor(tempC, normalizedTempThresholds) : "var(--status-unavailable)";
            const coreTemperatureColor = hasCoreTemperature ? tireTempColor(coreTempC, normalizedTempThresholds) : temperatureColor;
            const temperature = showsTemperature ? units.temp(tempC).toFixed(0) : null;
            const coreTemperature = hasCoreTemperature ? units.temp(coreTempC).toFixed(0) : null;
            const isLeft = wheel.label.endsWith("L");
            const isRight = !isLeft;
            const isRear = wheel.label.startsWith("R");
            const temperatureBands = wheel.temperatureBandsC;
            const hasTemperatureBands =
              showsTemperature && temperatureBands !== undefined && Number.isFinite(temperatureBands.inner) && Number.isFinite(temperatureBands.middle) && Number.isFinite(temperatureBands.outer);
            const visualTemperatureBands = hasTemperatureBands
              ? isLeft
                ? ([
                    ["Outer", temperatureBands.outer],
                    ["Middle", temperatureBands.middle],
                    ["Inner", temperatureBands.inner],
                  ] as const)
                : ([
                    ["Inner", temperatureBands.inner],
                    ["Middle", temperatureBands.middle],
                    ["Outer", temperatureBands.outer],
                  ] as const)
              : null;

            return (
              <div key={wheel.label} className={`flex items-center gap-2 ${isRight ? "flex-row-reverse" : ""}`}>
                <div className={`flex-1 min-w-0 ${isLeft ? "text-right" : ""}`}>
                  {hasCoreTemperature ? (
                    <div className="flex flex-col text-sm font-mono font-bold tabular-nums leading-tight">
                      <span aria-label={`${m.label_surface()}: ${temperature}${units.tempLabel}`} style={{ color: temperatureColor }}>
                        {temperature}
                        {units.tempLabel}
                      </span>
                      <span aria-label={`${m.label_core()}: ${coreTemperature}${units.tempLabel}`} style={{ color: coreTemperatureColor }}>
                        {coreTemperature}
                        {units.tempLabel}
                      </span>
                    </div>
                  ) : (
                    <div className="text-xl font-mono font-bold tabular-nums leading-none" style={{ color: temperatureColor }}>
                      {showsTemperature ? (
                        <>
                          {temperature}
                          {units.tempLabel}
                        </>
                      ) : (
                        "—"
                      )}
                    </div>
                  )}
                  {showsHealth && (
                    <div className="mt-1">
                      <span className="text-xs font-mono font-bold tabular-nums" style={{ color: healthColor }}>
                        {health.toFixed(0)}%
                      </span>
                    </div>
                  )}
                  {hasPressure && wheel.pressure !== undefined && (
                    <div className="mt-1 text-sm font-mono font-bold tabular-nums leading-none">
                      <span style={{ color: pressureOptimal ? tirePressureColor(wheel.pressure, pressureOptimal) : "var(--app-text-muted)" }}>{wheel.pressure.toFixed(1)}psi</span>
                    </div>
                  )}
                </div>

                <div className="relative w-6 h-12 rounded-sm overflow-hidden bg-app-surface-alt/50 shrink-0">
                  {hasCoreTemperature && (
                    <>
                      <div className="absolute inset-x-0 top-0 h-[5px]" style={{ backgroundColor: temperatureColor }} />
                      <div className="absolute inset-x-0 bottom-0 h-[5px]" style={{ backgroundColor: temperatureColor }} />
                    </>
                  )}
                  {visualTemperatureBands ? (
                    <div className={hasCoreTemperature ? "absolute inset-x-0 top-[7px] bottom-[7px] flex gap-px" : "absolute inset-0 flex gap-px"}>
                      {visualTemperatureBands.map(([label, value]) => (
                        <div
                          key={label}
                          className="min-w-0 flex-1"
                          aria-label={`${label} carcass: ${units.temp(value).toFixed(0)}${units.tempLabel}`}
                          style={{ backgroundColor: tireTempColor(value, normalizedTempThresholds) }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className={hasCoreTemperature ? "absolute inset-x-0 top-[7px] bottom-[7px]" : "absolute inset-0"}
                      style={{ backgroundColor: showsTemperature ? coreTemperatureColor : "transparent" }}
                    />
                  )}
                </div>
                {hasBrake && (
                  <div className={`flex items-center gap-1 shrink-0 ${isRight ? "flex-row-reverse" : ""}`}>
                    {(() => {
                      const pct = wheel.brakePadMm !== undefined ? Math.max(0, Math.min(100, (wheel.brakePadMm / PAD_NEW_MM) * 100)) : 100;
                      const color = brakeTempColor(wheel.brakeTemp ?? 0, isRear, brakeTempThresholds);
                      return (
                        <div className="relative w-2 h-12 overflow-hidden bg-app-surface-alt/50 shrink-0">
                          <div className="absolute bottom-0 left-0 right-0" style={{ backgroundColor: color, height: `${pct}%` }} />
                        </div>
                      );
                    })()}
                    <div className="flex flex-col text-sm font-mono font-bold tabular-nums leading-none gap-1">
                      {wheel.brakeTemp !== undefined &&
                        (() => {
                          const color = brakeTempColor(wheel.brakeTemp, isRear, brakeTempThresholds);
                          return (
                            <span style={{ color }}>
                              B:{units.temp(wheel.brakeTemp).toFixed(0)}
                              {units.tempLabel}
                            </span>
                          );
                        })()}
                      {wheel.brakePadMm !== undefined &&
                        (() => {
                          const pct = Math.max(0, Math.min(100, (wheel.brakePadMm / PAD_NEW_MM) * 100));
                          const color = tireHealthColor(1 - pct / 100, { green: 0.6, yellow: 0.3 });
                          return <span style={{ color }}>{pct.toFixed(0)}%</span>;
                        })()}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
