import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveBalance, resolveGripDemand, resolveWheelMetric, resolveWheelStates } from "../../../../shared/racing/analysis/metric-values";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import type { GameId } from "../../../../shared/games/ids";
import type { useUnits } from "../../hooks/useUnits";
import { severityRangeColor, signedBalanceColor } from "../../lib/colors";
import { frictionUtilColor, slipRatioColor, tireState, tireTempLabel } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";
import type { SemanticAnalysisFrame } from "./track-map/types";

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const number = (frame: SemanticAnalysisFrame, id: string): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const values = (frame: SemanticAnalysisFrame, id: string): (number | null)[] => {
  const value = frame.values[id];
  return WHEELS.map((_, index) => Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : null);
};
const bool = (frame: SemanticAnalysisFrame, id: string, index: number): boolean => {
  const value = frame.values[id];
  return Array.isArray(value) ? value[index] === true || value[index] === 1 : false;
};

interface Props {
  frame: SemanticAnalysisFrame;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
}
export function AnalyseDynamicsPanel({ frame, gameId, units }: Props) {
  const analysis = resolveAnalysisTelemetry(getGame(gameId));
  const speed = number(frame, "motion.speed") ?? 0;
  const speedFactor = Math.max(0.3, Math.min(1, (speed * 2.23694) / 80));
  const accelerationX = number(frame, "motion.acceleration-x");
  const accelerationZ = number(frame, "motion.acceleration-z");
  const bindingOf = (metric: ReturnType<typeof resolveAnalysisTelemetry>[keyof ReturnType<typeof resolveAnalysisTelemetry>]) =>
    metric.source !== "unavailable" && metric.binding?.kind === "value" ? metric.binding : undefined;
  const slipAngleMetric = analysis.slipAngle;
  const slipRatioMetric = analysis.slipRatio;
  const slipAngles = bindingOf(slipAngleMetric) ? resolveWheelMetric(frame, bindingOf(slipAngleMetric)!) : [null, null, null, null];
  const states = resolveWheelStates(frame, analysis.traction);
  const slipRatios = slipRatioMetric.source === "unavailable"
    ? [null, null, null, null]
    : states.map((state) => state?.slipRatio ?? null);
  const grip = resolveGripDemand(frame, analysis.gripDemand);
  const temps = bindingOf(analysis.tireTemperature) ? resolveWheelMetric(frame, bindingOf(analysis.tireTemperature)!) : [null, null, null, null];
  const balance = resolveBalance(frame, analysis.balance);
  const brakeBias = number(frame, "brakes.brake-bias");
  const surfaceValue = number(frame, "identity.player-track-surface");
  const puddle = values(frame, "tires.wheel-in-puddle-depth");
  const surfaceBinding = analysis.surface.source !== "unavailable" ? analysis.surface.binding : undefined;
  const lateralG = analysis.gForce.source !== "unavailable" && accelerationX != null ? -accelerationX / 9.81 : null;
  const longitudinalG = analysis.gForce.source !== "unavailable" && accelerationZ != null ? -accelerationZ / 9.81 : null;
  const balanceColor = balance?.state === "neutral" ? "var(--balance-neutral)" : balance?.state === "understeer" ? "var(--balance-positive)" : "var(--balance-negative)";
  const angleColor = (value: number) => severityRangeColor(Math.abs(value * 180 / Math.PI), [4 / speedFactor, 8 / speedFactor, 14 / speedFactor]);
  const C = (value: string, color: string) => <span style={{ color }}>{value}</span>;
  const unavailable = <span className="text-app-text-dim">—</span>;
  const surfaceText = surfaceValue === -1 ? m.analyse_surface_not_in_world() : surfaceValue === 0 ? m.analyse_surface_off_track() : surfaceValue === 1 ? m.analyse_surface_pit_stall() : surfaceValue === 2 ? m.analyse_surface_approaching_pits() : surfaceValue === 3 ? m.analyse_surface_on_track() : m.analyse_surface_unknown();
  const balanceBarX = (value: number, range = 1) => Math.max(2, Math.min(198, 100 + (Math.max(-range, Math.min(range, value)) / range) * 98));
  const balanceTooltip = balance && (
    <span className="pointer-events-none absolute top-full left-0 z-50 mt-2 hidden w-[min(320px,calc(100vw-2rem))] rounded border border-app-border-input bg-app-surface-alt px-2.5 py-2 text-app-caption text-app-text-secondary normal-case tracking-normal group-hover:block group-focus-within:block">
      <span className="block mb-1">{balance.slipAvailable ? "Yaw rate vs path curvature + front/rear slip-angle delta." : "Yaw rate versus path curvature (tire slip angles unavailable for this game)."}</span>
      <span className="block mb-2 text-app-text-dim">{balance.slipAvailable ? <>+ = understeer (front slip &gt; rear) | − = oversteer (body yawing past Ay/V)</> : <>+ = understeer (under-rotating) | − = oversteer (over-rotating)</>}<br />Gated by |latG| ≥ 0.25g — straight-line wheelspin ignored</span>
      <svg viewBox="0 0 200 110" className="w-full h-auto" aria-hidden="true">
        {[
          { label: "Slip Δ", value: balance.uSlip, color: signedBalanceColor(balance.uSlip, 0.05), y: 16, desc: balance.slipAvailable ? `F ${balance.frontSlipDeg.toFixed(1)}° / R ${balance.rearSlipDeg.toFixed(1)}°` : "Unavailable", opacity: balance.slipAvailable ? 1 : 0.35 },
          { label: "Yaw", value: balance.uYaw, color: signedBalanceColor(balance.uYaw, 0.05), y: 40, desc: `err ${balance.yawError > 0 ? "+" : ""}${balance.yawError.toFixed(2)} r/s (path ${balance.yawRatePath.toFixed(2)})`, opacity: Math.min(1, balance.yawRatePath / 0.15) },
        ].map((signal) => {
          const left = balanceBarX(-0.3);
          const right = balanceBarX(0.3);
          return <g key={signal.label} opacity={signal.opacity}><text x="0" y={signal.y - 4} fill="currentColor" opacity="0.5" fontSize="6.5">{signal.label}</text><rect x="0" y={signal.y} width="200" height="10" rx="1" fill="currentColor" opacity="0.06" /><rect x="0" y={signal.y} width={left} height="10" fill="var(--balance-negative)" opacity="0.12" /><rect x={left} y={signal.y} width={right - left} height="10" fill="var(--balance-neutral)" opacity="0.12" /><rect x={right} y={signal.y} width={200 - right} height="10" fill="var(--balance-positive)" opacity="0.12" /><line x1="100" y1={signal.y} x2="100" y2={signal.y + 10} stroke="currentColor" opacity="0.2" /><circle cx={balanceBarX(signal.value)} cy={signal.y + 5} r="4" fill={signal.color} stroke="var(--app-surface)" strokeWidth="1" /><text x="0" y={signal.y + 20} fill="currentColor" opacity="0.35" fontSize="6">{signal.desc}</text></g>;
        })}
        <text x="100" y="70" textAnchor="middle" fill={balance.slipAvailable ? (balance.signalsAgree ? "var(--status-success)" : "var(--status-warning)") : "var(--status-warning)"} fontSize="7" fontWeight="var(--font-weight-semibold)">{balance.slipAvailable ? (balance.signalsAgree ? "SIGNALS AGREE — blended 50/50" : "CONFLICT — slip angle used alone") : "YAW ONLY — curvature signal"}</text>
        <text x="0" y="80" fill="currentColor" opacity="0.5" fontSize="6.5">Combined</text><rect x="0" y="82" width="200" height="10" rx="1" fill="currentColor" opacity="0.06" /><rect x="0" y="82" width={balanceBarX(-0.3)} height="10" fill="var(--balance-negative)" opacity="0.18" /><rect x={balanceBarX(-0.3)} y="82" width={balanceBarX(0.3) - balanceBarX(-0.3)} height="10" fill="var(--balance-neutral)" opacity="0.18" /><rect x={balanceBarX(0.3)} y="82" width={200 - balanceBarX(0.3)} height="10" fill="var(--balance-positive)" opacity="0.18" /><line x1="100" y1="82" x2="100" y2="92" stroke="currentColor" opacity="0.25" /><circle cx={balanceBarX(balance.balance)} cy="87" r="4" fill={balanceColor} stroke="var(--app-surface)" strokeWidth="1.2" /><text x="20" y="106" textAnchor="middle" fill="var(--balance-negative)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_over()}</text><text x="100" y="106" textAnchor="middle" fill="var(--balance-neutral)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_neutral()}</text><text x="180" y="106" textAnchor="middle" fill="var(--balance-positive)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_under()}</text>
      </svg>
    </span>
  );
  const surfaceCell = (index: number) => bool(frame, "tires.wheel-on-rumble-strip", index) ? C(m.analyse_dynamics_curb(), "var(--surface-curb)") : (puddle[index] ?? 0) > 0 ? C(`${m.analyse_dynamics_wet()} ${((puddle[index] ?? 0) * 100).toFixed(0)}%`, "var(--surface-wet)") : unavailable;
  const tractionCell = (index: number) => {
    const state = states[index];
    const angle = slipAngles[index];
    const ratio = state?.slipRatio ?? slipRatios[index];
    return state && angle != null && ratio != null ? (() => { const result = tireState(state.state, ratio, angle); return C(result.label, result.color); })() : unavailable;
  };
  const wheelRow = (label: string, render: (index: number) => ReactNode) => ({ label, fl: render(0), fr: render(1), rl: render(2), rr: render(3) });
  return <div className="text-app-compact font-mono space-y-1.5 mb-3">
    <div className="flex justify-between"><span className="group relative flex items-center gap-1 text-app-text-muted outline-none focus-visible:ring-2 focus-visible:ring-app-accent" tabIndex={0} aria-label={`${m.label_balance()}: Balance tooltip`} >{m.label_balance()} {balance && <><Info className="size-3 cursor-help text-app-text-dim" aria-hidden="true" />{balanceTooltip}</>}</span><span className="tabular-nums text-app-text-dim">{balance ? <span style={{ color: balanceColor }}>{balance.state === "neutral" ? "Neutral" : balance.state === "understeer" ? "Understeer" : "Oversteer"}({balance.balance > 0 ? "+" : ""}{balance.balance.toFixed(2)})</span> : m.analyse_unavailable()}</span></div>
    <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_g_force()}</span><span className="tabular-nums text-app-text">Lat {lateralG == null ? "—" : `${lateralG > 0 ? "+" : ""}${lateralG.toFixed(2)}g`} Lon {longitudinalG == null ? "—" : `${longitudinalG > 0 ? "+" : ""}${longitudinalG.toFixed(2)}g`}</span></div>
    {(gameId === "acc" || gameId === "ac-evo") && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_brake_bias()}</span><span className="tabular-nums text-app-text">{brakeBias == null ? "—" : `${(brakeBias * 100).toFixed(1)}%F`}</span></div>}
    <WheelTable rows={[wheelRow(m.analyse_dynamics_grip_ask(), (i) => grip[i] == null ? unavailable : C(`${(grip[i]! * 100).toFixed(0)}%`, frictionUtilColor(grip[i]!))), wheelRow(m.analyse_dynamics_traction(), tractionCell), wheelRow(analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot" ? m.analyse_wheels_pit_temp() : m.analyse_dynamics_temp(), (i) => temps[i] == null ? unavailable : C(tireTempLabel(units.toTempC(temps[i]!), units.thresholds).label, tireTempLabel(units.toTempC(temps[i]!), units.thresholds).color)), ...(surfaceBinding?.kind === "group" ? [wheelRow(m.analyse_dynamics_surface(), surfaceCell)] : [])]} />
    {surfaceBinding?.kind === "value" && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_dynamics_surface()}</span><span className="text-app-text">{surfaceText}</span></div>}
    <WheelTable title={<span className="flex items-center gap-1 group relative">{m.label_slip()}<Info className="size-3 text-app-text-dim cursor-help" aria-hidden="true" /></span>} borderTop rows={[wheelRow(m.analyse_dynamics_ratio(), (i) => slipRatios[i] == null ? unavailable : C(`${(slipRatios[i]! * 100).toFixed(0)}%`, slipRatioColor(slipRatios[i]!))), wheelRow(m.analyse_dynamics_angle(), (i) => slipAngles[i] == null ? unavailable : C(`${(slipAngles[i]! * 180 / Math.PI).toFixed(1)}°`, angleColor(slipAngles[i]!)))]} />
  </div>;
}
