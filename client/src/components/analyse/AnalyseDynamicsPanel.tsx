import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { frictionCircleUtil, semanticWheelDynamics, steerBalanceFromSignals } from "../../../../shared/racing/analysis/laps/physics/vehicle";
import { Info } from "lucide-react";
import type { GameId } from "../../../../shared/games/ids";
import type { useUnits } from "../../hooks/useUnits";
import { severityRangeColor, signedBalanceColor } from "../../lib/colors";
import { frictionUtilColor, slipRatioColor, tireState, tireTempLabel } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";
import type { SemanticAnalysisFrame } from "./track-map/types";

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const unavailable = <span className="text-app-text-dim">—</span>;
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
  const puddle = values(frame, "tires.wheel-in-puddle-depth");
  const accelerationX = number(frame, "motion.acceleration-x") ?? 0;
  const accelerationZ = number(frame, "motion.acceleration-z") ?? 0;
  const slipAngles = values(frame, "tires.tire-slip-angle");
  const slipRatios = values(frame, "tires.tire-slip-ratio");
  const rotation = values(frame, "tires.wheel-rotation-speed");
  const radius = values(frame, "tires.tire-radius");
  const radiusM = radius.every((value) => value != null) ? radius.reduce((sum, value) => sum + (value ?? 0), 0) / 4 : 0.33;
  const wheel = semanticWheelDynamics({ speedMps: speed, steer: number(frame, "inputs.steer") ?? 0, wheelRotationRadS: { fl: rotation[0] ?? 0, fr: rotation[1] ?? 0, rl: rotation[2] ?? 0, rr: rotation[3] ?? 0 }, wheelRadiusM: radiusM });
  const grip = slipRatios.map((ratio, index) => ratio == null || slipAngles[index] == null ? null : frictionCircleUtil(ratio, slipAngles[index]!));
  const balance = steerBalanceFromSignals({ speedMps: speed, accelerationX, yawRate: number(frame, "motion.angular-velocity-y") ?? 0, slipAngles: [slipAngles[0] ?? 0, slipAngles[1] ?? 0, slipAngles[2] ?? 0, slipAngles[3] ?? 0] });
  const states = [wheel.fl, wheel.fr, wheel.rl, wheel.rr].map((state, index) => tireState(state.state, slipRatios[index] ?? 0, slipAngles[index] ?? 0));
  const temps = values(frame, "tire.temperature.average");
  const C = (value: string, color: string) => <span style={{ color }}>{value}</span>;
  const surfaceValue = number(frame, "identity.player-track-surface");
  const vehicleSurface = surfaceValue === -1 ? m.analyse_surface_not_in_world() : surfaceValue === 0 ? m.analyse_surface_off_track() : surfaceValue === 1 ? m.analyse_surface_pit_stall() : surfaceValue === 2 ? m.analyse_surface_approaching_pits() : surfaceValue === 3 ? m.analyse_surface_on_track() : m.analyse_surface_unknown();
  const balanceLabel = balance.state === "neutral" ? m.dynamics_neutral() : balance.state === "understeer" ? m.dynamics_under() : m.dynamics_over();
  const balanceColor = balance.state === "neutral" ? "var(--balance-neutral)" : balance.state === "understeer" ? "var(--balance-positive)" : "var(--balance-negative)";
  const sf = Math.max(0.3, Math.min(1, (speed * 2.23694) / 80));
  const angleColor = (value: number) => severityRangeColor(Math.abs(value * 180 / Math.PI), [4 / sf, 8 / sf, 14 / sf]);
  const brakeBias = number(frame, "brakes.brake-bias");
  const balanceBarX = (value: number, range = 1) => Math.max(2, Math.min(198, 100 + (Math.max(-range, Math.min(range, value)) / range) * 98));
  const balanceTooltip = (
    <span className="pointer-events-none absolute top-full left-0 z-50 mt-2 hidden w-[min(320px,calc(100vw-2rem))] rounded border border-app-border-input bg-app-surface-alt px-2.5 py-2 text-app-caption text-app-text-secondary normal-case tracking-normal group-hover:block group-focus-within:block">
      <span className="block mb-1">{m.dynamics_balance_tooltip_desc()}</span>
      <span className="block mb-2 text-app-text-dim">
        {m.dynamics_balance_polarity_desc()}
        <br />
        {m.dynamics_balance_gated_desc()}
      </span>
      <svg viewBox="0 0 200 110" className="w-full h-auto" aria-hidden="true">
        {[
          { label: m.dynamics_slip_delta_label(), value: balance.uSlip, color: signedBalanceColor(balance.uSlip, 0.05), y: 16, desc: `F ${balance.frontSlipDeg.toFixed(1)}° / R ${balance.rearSlipDeg.toFixed(1)}°`, opacity: 1 },
          { label: m.dynamics_yaw_label(), value: balance.uYaw, color: signedBalanceColor(balance.uYaw, 0.05), y: 40, desc: `err ${balance.yawError > 0 ? "+" : ""}${balance.yawError.toFixed(2)} r/s (path ${balance.yawRatePath.toFixed(2)})`, opacity: Math.min(1, balance.yawRatePath / 0.15) },
        ].map((signal) => {
          const left = balanceBarX(-0.3);
          const right = balanceBarX(0.3);
          return (
            <g key={signal.label} opacity={signal.opacity}>
              <text x="0" y={signal.y - 4} fill="currentColor" opacity="0.5" fontSize="6.5">{signal.label}</text>
              <rect x="0" y={signal.y} width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
              <rect x="0" y={signal.y} width={left} height="10" fill="var(--balance-negative)" opacity="0.12" />
              <rect x={left} y={signal.y} width={right - left} height="10" fill="var(--balance-neutral)" opacity="0.12" />
              <rect x={right} y={signal.y} width={200 - right} height="10" fill="var(--balance-positive)" opacity="0.12" />
              <line x1="100" y1={signal.y} x2="100" y2={signal.y + 10} stroke="currentColor" opacity="0.2" />
              <circle cx={balanceBarX(signal.value)} cy={signal.y + 5} r="4" fill={signal.color} stroke="var(--app-surface)" strokeWidth="1" />
              <text x="0" y={signal.y + 20} fill="currentColor" opacity="0.35" fontSize="6">{signal.desc}</text>
            </g>
          );
        })}
        {balance.signalsAgree ? (
          <text x="100" y="70" textAnchor="middle" fill="var(--status-success)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_signals_agree()}</text>
        ) : (
          <text x="100" y="70" textAnchor="middle" fill="var(--status-warning)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_signals_conflict()}</text>
        )}
        <text x="0" y="80" fill="currentColor" opacity="0.5" fontSize="6.5">{m.dynamics_combined()}</text>
        <rect x="0" y="82" width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
        <rect x="0" y="82" width={balanceBarX(-0.3)} height="10" fill="var(--balance-negative)" opacity="0.18" />
        <rect x={balanceBarX(-0.3)} y="82" width={balanceBarX(0.3) - balanceBarX(-0.3)} height="10" fill="var(--balance-neutral)" opacity="0.18" />
        <rect x={balanceBarX(0.3)} y="82" width={200 - balanceBarX(0.3)} height="10" fill="var(--balance-positive)" opacity="0.18" />
        <line x1="100" y1="82" x2="100" y2="92" stroke="currentColor" opacity="0.25" />
        <circle cx={balanceBarX(balance.balance)} cy="87" r="4" fill={balanceColor} stroke="var(--app-surface)" strokeWidth="1.2" />
        <text x="20" y="106" textAnchor="middle" fill="var(--balance-negative)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_over()}</text>
        <text x="100" y="106" textAnchor="middle" fill="var(--balance-neutral)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_neutral()}</text>
        <text x="180" y="106" textAnchor="middle" fill="var(--balance-positive)" fontSize="7" fontWeight="var(--font-weight-semibold)">{m.dynamics_under()}</text>
      </svg>
    </span>
  );

  const surfaceCell = (index: number) => bool(frame, "tires.wheel-on-rumble-strip", index)
    ? C(m.analyse_dynamics_curb(), "var(--surface-curb)")
    : (puddle[index] ?? 0) > 0
      ? C(`${m.analyse_dynamics_wet()} ${((puddle[index] ?? 0) * 100).toFixed(0)}%`, "var(--surface-wet)")
      : unavailable;
  return <div className="text-app-compact font-mono space-y-1.5 mb-3">
    <div className="flex justify-between">
      {analysis.balance.source === "unavailable" ? (
        <span className="text-app-text-muted">{m.label_balance()}</span>
      ) : (
        <span className="group relative flex items-center gap-1 text-app-text-muted outline-none focus-visible:ring-2 focus-visible:ring-app-accent" tabIndex={0} aria-label={`${m.label_balance()}: ${m.dynamics_balance_tooltip_desc()}`}>
          {m.label_balance()} <Info className="size-3 cursor-help text-app-text-dim" aria-hidden="true" />
          {balanceTooltip}
        </span>
      )}
      {analysis.balance.source === "unavailable" ? <span className="text-app-text-dim">{m.analyse_unavailable()}</span> : <span className="tabular-nums" style={{ color: balanceColor }}>{balanceLabel} ({balance.balance > 0 ? "+" : ""}{balance.balance.toFixed(2)})</span>}
    </div>
    <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_g_force()}</span><span className="tabular-nums text-app-text">Lat {(-accelerationX / 9.81) > 0 ? "+" : ""}{(-accelerationX / 9.81).toFixed(2)}g Lon {(-accelerationZ / 9.81) > 0 ? "+" : ""}{(-accelerationZ / 9.81).toFixed(2)}g</span></div>
    {brakeBias != null && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_brake_bias()}</span><span className="tabular-nums text-app-text">{(brakeBias * 100).toFixed(1)}%F</span></div>}
    <WheelTable rows={[
      { label: m.analyse_dynamics_grip_ask(), fl: grip[0] == null ? unavailable : C(`${(grip[0] * 100).toFixed(0)}%`, frictionUtilColor(grip[0])), fr: grip[1] == null ? unavailable : C(`${(grip[1] * 100).toFixed(0)}%`, frictionUtilColor(grip[1])), rl: grip[2] == null ? unavailable : C(`${(grip[2] * 100).toFixed(0)}%`, frictionUtilColor(grip[2])), rr: grip[3] == null ? unavailable : C(`${(grip[3] * 100).toFixed(0)}%`, frictionUtilColor(grip[3])) },
      { label: m.analyse_dynamics_traction(), fl: C(states[0].label, states[0].color), fr: C(states[1].label, states[1].color), rl: C(states[2].label, states[2].color), rr: C(states[3].label, states[3].color) },
      { label: m.analyse_dynamics_temp(), fl: temps[0] == null ? unavailable : C(tireTempLabel(temps[0], units.thresholds).label, tireTempLabel(temps[0], units.thresholds).color), fr: temps[1] == null ? unavailable : C(tireTempLabel(temps[1], units.thresholds).label, tireTempLabel(temps[1], units.thresholds).color), rl: temps[2] == null ? unavailable : C(tireTempLabel(temps[2], units.thresholds).label, tireTempLabel(temps[2], units.thresholds).color), rr: temps[3] == null ? unavailable : C(tireTempLabel(temps[3], units.thresholds).label, tireTempLabel(temps[3], units.thresholds).color) },
      ...(analysis.surface.display === "per-wheel" ? [{ label: m.analyse_dynamics_surface(), fl: surfaceCell(0), fr: surfaceCell(1), rl: surfaceCell(2), rr: surfaceCell(3) }] : []),
    ]} />
    {analysis.surface.display === "vehicle" && <div className="flex justify-between"><span className="text-app-text-muted">{m.analyse_dynamics_surface()}</span><span className="text-app-text">{vehicleSurface}</span></div>}
    <WheelTable title={m.label_slip()} borderTop rows={[{ label: m.analyse_dynamics_ratio(), fl: C(`${((slipRatios[0] ?? 0) * 100).toFixed(0)}%`, slipRatioColor(slipRatios[0] ?? 0)), fr: C(`${((slipRatios[1] ?? 0) * 100).toFixed(0)}%`, slipRatioColor(slipRatios[1] ?? 0)), rl: C(`${((slipRatios[2] ?? 0) * 100).toFixed(0)}%`, slipRatioColor(slipRatios[2] ?? 0)), rr: C(`${((slipRatios[3] ?? 0) * 100).toFixed(0)}%`, slipRatioColor(slipRatios[3] ?? 0)) }, { label: m.analyse_dynamics_angle(), fl: slipAngles[0] == null ? unavailable : C(`${(slipAngles[0] * 180 / Math.PI).toFixed(1)}°`, angleColor(slipAngles[0])), fr: slipAngles[1] == null ? unavailable : C(`${(slipAngles[1] * 180 / Math.PI).toFixed(1)}°`, angleColor(slipAngles[1])), rl: slipAngles[2] == null ? unavailable : C(`${(slipAngles[2] * 180 / Math.PI).toFixed(1)}°`, angleColor(slipAngles[2])), rr: slipAngles[3] == null ? unavailable : C(`${(slipAngles[3] * 180 / Math.PI).toFixed(1)}°`, angleColor(slipAngles[3])) }]} />
  </div>;
}
