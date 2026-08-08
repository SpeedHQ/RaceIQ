import type { GameId } from "../../../../shared/games/ids";
import { useTirePressureOptimal } from "../../hooks/catalog-queries";
import type { useUnits } from "../../hooks/useUnits";
import { brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor, wearRateColor } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";
import type { SemanticAnalysisFrame } from "./track-map/types";

interface WearRate { FL: number; FR: number; RL: number; RR: number; }
interface Props { frame: SemanticAnalysisFrame; gameId: GameId; units: ReturnType<typeof useUnits>; wearRate: WearRate | null; }
const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const vals = (f: SemanticAnalysisFrame, id: string): (number | null)[] => { const v = f.values[id]; return WHEELS.map((_, i) => Array.isArray(v) && typeof v[i] === "number" && Number.isFinite(v[i]) ? v[i] : null); };
const unavailable = <span className="text-app-text-dim">—</span>;
export function AnalyseTireWheelsPanel({ frame, gameId, units, wearRate }: Props) {
  const temp = vals(frame, "tire.temperature.average"); const health = vals(frame, "tires.tire-wear"); const speed = vals(frame, "tires.wheel-rotation-speed");
  const brake = vals(frame, "brakes.brake-temp"); const pressure = vals(frame, "tires.tire-pressure");
  const optimal = useTirePressureOptimal(gameId, typeof frame.values["identity.car-ordinal"] === "number" ? frame.values["identity.car-ordinal"] : 0);
  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;
  const rows = [{ label: m.analyse_wheels_rotation_s(), fl: speed[0]?.toFixed(1) ?? unavailable, fr: speed[1]?.toFixed(1) ?? unavailable, rl: speed[2]?.toFixed(1) ?? unavailable, rr: speed[3]?.toFixed(1) ?? unavailable },
    { label: m.analyse_wheels_temp(), ...Object.fromEntries(WHEELS.map((w, i) => [w.toLowerCase(), temp[i] == null ? unavailable : C(`${temp[i]!.toFixed(0)}${units.tempLabel}`, tireTempColor(units.toTempC(temp[i]!), units.thresholds))])) },
    { label: m.analyse_wheels_health(), ...Object.fromEntries(WHEELS.map((w, i) => [w.toLowerCase(), health[i] == null ? unavailable : C(`${((1 - health[i]!) * 100).toFixed(1)}%`, tireHealthColor(health[i]!, { green: .7, yellow: .4 }))])) },
    ...(wearRate ? [{ label: m.analyse_wheels_wear_s(), ...Object.fromEntries(WHEELS.map((w) => [w.toLowerCase(), C(`${wearRate[w] * 100}%`, wearRateColor(wearRate[w] * 100))])) }] : []),
    ...(brake.some((v) => v != null) ? [{ label: m.analyse_wheels_brake(), ...Object.fromEntries(WHEELS.map((w, i) => [w.toLowerCase(), brake[i] == null ? unavailable : C(`${brake[i]!.toFixed(0)}°C`, brakeTempColor(brake[i]!, i > 1))])) }] : []),
    ...(pressure.some((v) => v != null) ? [{ label: m.analyse_wheels_pressure(), ...Object.fromEntries(WHEELS.map((w, i) => [w.toLowerCase(), pressure[i] == null ? unavailable : C(`${pressure[i]!.toFixed(1)} psi`, tirePressureColor(pressure[i]!, optimal))])) }] : [])];
  return <WheelTable title={m.analyse_wheels_wheels()} borderTop rows={rows as never} />;
}
