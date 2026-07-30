import { useUnits } from "@/hooks/useUnits";
import { type BrakeTempThresholds, brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";

const PAD_NEW_MM = 29; // ACC: pads start at 29mm when new

export interface WheelData {
  tempC: number; // always °C — caller normalises
  wear: number; // 0 (new) → 1 (gone)
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
}

export function TireGrid({ corners, fl, fr, rl, rr, healthThresholds, tempThresholds, pressureOptimal, brakeTempThresholds, compound }: TireGridProps) {
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

  const hasBrake = wheels.some((w) => w.brakeTemp !== undefined);
  const hasPressure = wheels.some((w) => w.pressure !== undefined);

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.label_tires()}</h2>
        {compound && (
          <span className="tire-compound-badge text-xs font-bold uppercase px-2 py-0.5 rounded" data-tire-compound={compound.toLowerCase()}>
            {compound}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {wheels.map((w) => {
            const h = Math.max(0, (1 - w.wear) * 100);
            const healthColor = tireHealthColor(w.wear, healthThresholds);
            const temperatureColor = tireTempColor(w.tempC, normalizedTempThresholds);
            const tempDisplay = units.tempUnit === "F" ? Math.round((w.tempC * 9) / 5 + 32) : Math.round(w.tempC);

            const isLeft = w.label.endsWith("L");
            const isRight = !isLeft;
            const isRear = w.label.startsWith("R");

            return (
              <div key={w.label} className={`flex items-center gap-2 ${isRight ? "flex-row-reverse" : ""}`}>
                {/* Tire text — outside edge */}
                <div className={`flex-1 min-w-0 ${isLeft ? "text-right" : ""}`}>
                  <div className="text-xl font-mono font-bold tabular-nums leading-none" style={{ color: temperatureColor }}>
                    {tempDisplay}
                    {units.tempLabel}
                  </div>
                  <div className="mt-1">
                    <span className="text-xs font-mono font-bold tabular-nums" style={{ color: healthColor }}>
                      {h.toFixed(0)}%
                    </span>
                  </div>
                  {hasPressure && w.pressure !== undefined && (
                    <div className="mt-1 text-sm font-mono font-bold tabular-nums leading-none">
                      <span style={{ color: pressureOptimal ? tirePressureColor(w.pressure, pressureOptimal) : "var(--app-text-muted)" }}>
                        {w.pressure.toFixed(1)}psi
                      </span>
                    </div>
                  )}
                </div>

                {/* Wheel bar — fill height = health, color = temp */}
                <div className="relative w-6 h-12 rounded-sm overflow-hidden bg-app-surface-alt/50 shrink-0">
                  <div className="absolute bottom-0 left-0 right-0" style={{ backgroundColor: temperatureColor, height: `${h}%` }} />
                </div>

                {/* Brake group — center of car */}
                {hasBrake && (
                  <div className={`flex items-center gap-1 shrink-0 ${isRight ? "flex-row-reverse" : ""}`}>
                    {(() => {
                      const pct = w.brakePadMm !== undefined ? Math.max(0, Math.min(100, (w.brakePadMm / PAD_NEW_MM) * 100)) : 100;
                      const color = brakeTempColor(w.brakeTemp ?? 0, isRear, brakeTempThresholds);
                      return (
                        <div className="relative w-2 h-12 overflow-hidden bg-app-surface-alt/50 shrink-0">
                          <div className="absolute bottom-0 left-0 right-0" style={{ backgroundColor: color, height: `${pct}%` }} />
                        </div>
                      );
                    })()}
                    <div className="flex flex-col text-sm font-mono font-bold tabular-nums leading-none gap-1">
                      {w.brakeTemp !== undefined &&
                        (() => {
                          const color = brakeTempColor(w.brakeTemp, isRear, brakeTempThresholds);
                          return <span style={{ color }}>B:{Math.round(w.brakeTemp)}&deg;C</span>;
                        })()}
                      {w.brakePadMm !== undefined &&
                        (() => {
                          const pct = Math.max(0, Math.min(100, (w.brakePadMm / PAD_NEW_MM) * 100));
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
