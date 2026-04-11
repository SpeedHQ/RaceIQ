import { useUnits } from "@/hooks/useUnits";
import { brakeTempColor, BRAKE_COLOR_CLASSES, type BrakeTempThresholds } from "@/lib/vehicle-dynamics";

const PAD_NEW_MM = 29; // ACC: pads start at 29mm when new

export interface WheelData {
  tempC: number;       // always °C — caller normalises
  wear: number;        // 0 (new) → 1 (gone)
  brakeTemp?: number;  // °C, optional
  brakePadMm?: number; // mm remaining (ACC: new = 29mm), drives pad height
  pressure?: number;   // psi, optional
}

interface TireGridProps {
  fl: WheelData;
  fr: WheelData;
  rl: WheelData;
  rr: WheelData;
  healthThresholds: { green: number; yellow: number }; // fractions 0–1
  tempThresholds: { blue: number; orange: number; red: number }; // °C
  pressureOptimal?: { min: number; max: number }; // psi
  brakeTempThresholds?: BrakeTempThresholds;
  compound?: string;
  compoundStyle?: { bg: string; text: string };
}

export function TireGrid({ fl, fr, rl, rr, healthThresholds, tempThresholds, pressureOptimal, brakeTempThresholds, compound, compoundStyle }: TireGridProps) {
  const units = useUnits();
  const greenPct = healthThresholds.green * 100;
  const yellowPct = healthThresholds.yellow * 100;

  const wheels = [
    { label: "FL", ...fl },
    { label: "FR", ...fr },
    { label: "RL", ...rl },
    { label: "RR", ...rr },
  ];

  const hasBrake = wheels.some((w) => w.brakeTemp !== undefined);
  const hasPressure = wheels.some((w) => w.pressure !== undefined);

  const tempColor = (c: number) => {
    if (c > tempThresholds.red)    return "text-red-400";
    if (c > tempThresholds.orange) return "text-orange-400";
    if (c < tempThresholds.blue)   return "text-blue-400";
    return "text-emerald-400";
  };

  const tempBg = (c: number) => {
    if (c > tempThresholds.red)    return "bg-red-500";
    if (c > tempThresholds.orange) return "bg-orange-400";
    if (c < tempThresholds.blue)   return "bg-blue-500";
    return "bg-emerald-500";
  };


  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tires</h2>
        {compound && (
          <span
            className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
              compoundStyle ? `${compoundStyle.bg} ${compoundStyle.text}` : "bg-slate-700 text-slate-200"
            }`}
          >
            {compound}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {wheels.map((w) => {
            const h = Math.max(0, (1 - w.wear) * 100);
            const hTextColor = h > greenPct ? "text-emerald-400" : h > yellowPct ? "text-yellow-400" : "text-red-400";
            const tempDisplay = units.tempUnit === "F"
              ? Math.round(w.tempC * 9 / 5 + 32)
              : Math.round(w.tempC);

            const isLeft = w.label.endsWith("L");
            const isRight = !isLeft;
            const isRear = w.label.startsWith("R");

            return (
              <div key={w.label} className={`flex items-center gap-2 ${isRight ? "flex-row-reverse" : ""}`}>
                {/* Tire text — outside edge */}
                <div className={`flex-1 min-w-0 ${isLeft ? "text-right" : ""}`}>
                  <div className={`text-xl font-mono font-bold tabular-nums leading-none ${tempColor(w.tempC)}`}>
                    {tempDisplay}{units.tempLabel}
                  </div>
                  <div className="mt-1">
                    <span className={`text-xs font-mono font-bold tabular-nums ${hTextColor}`}>{h.toFixed(0)}%</span>
                  </div>
                  {hasPressure && w.pressure !== undefined && (
                    <div className="mt-1 text-sm font-mono font-bold tabular-nums leading-none">
                      <span className={
                        pressureOptimal
                          ? w.pressure < pressureOptimal.min ? "text-blue-400"
                          : w.pressure > pressureOptimal.max ? "text-orange-400"
                          : "text-emerald-400"
                          : "text-app-text-muted"
                      }>{w.pressure.toFixed(1)}psi</span>
                    </div>
                  )}
                </div>

                {/* Wheel bar — fill height = health, color = temp */}
                <div className="relative w-6 h-12 rounded-sm overflow-hidden bg-slate-700/50 shrink-0">
                  <div className={`absolute bottom-0 left-0 right-0 ${tempBg(w.tempC)}`} style={{ height: `${h}%` }} />
                </div>

                {/* Brake group — center of car */}
                {hasBrake && (
                  <div className={`flex items-center gap-1 shrink-0 ${isRight ? "flex-row-reverse" : ""}`}>
                    {(() => {
                      const pct = w.brakePadMm !== undefined
                        ? Math.max(0, Math.min(100, (w.brakePadMm / PAD_NEW_MM) * 100))
                        : 100;
                      const color = brakeTempColor(w.brakeTemp ?? 0, isRear, brakeTempThresholds);
                      return (
                        <div className="relative w-2 h-12 overflow-hidden bg-slate-700/50 shrink-0">
                          <div className={`absolute bottom-0 left-0 right-0 ${BRAKE_COLOR_CLASSES[color].bg}`} style={{ height: `${pct}%` }} />
                        </div>
                      );
                    })()}
                    <div className="flex flex-col text-sm font-mono font-bold tabular-nums leading-none gap-1">
                      {w.brakeTemp !== undefined && (() => {
                        const color = brakeTempColor(w.brakeTemp, isRear, brakeTempThresholds);
                        return <span className={BRAKE_COLOR_CLASSES[color].text}>B:{Math.round(w.brakeTemp)}&deg;C</span>;
                      })()}
                      {w.brakePadMm !== undefined && (() => {
                        const pct = Math.max(0, Math.min(100, (w.brakePadMm / PAD_NEW_MM) * 100));
                        const cls = pct > 60 ? "text-emerald-400" : pct > 30 ? "text-yellow-400" : "text-red-400";
                        return <span className={cls}>{pct.toFixed(0)}%</span>;
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
