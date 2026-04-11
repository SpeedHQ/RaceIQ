import type { TelemetryPacket, GameId } from "@shared/types";
import { Info } from "lucide-react";
import {
  allWheelStates,
  allFrictionCircle,
  steerBalance,
  tireState,
  slipRatioColor,
  frictionUtilColor,
  balanceColor,
  tireTempLabel,
} from "../../lib/vehicle-dynamics";
import type { useUnits } from "../../hooks/useUnits";
import { WheelTable } from "./WheelTable";

interface Props {
  currentPacket: TelemetryPacket;
  gameId: GameId | undefined;
  units: ReturnType<typeof useUnits>;
}

export function AnalyseDynamicsPanel({ currentPacket, gameId, units }: Props) {
  const isF1 = gameId === "f1-2025";
  const ws = allWheelStates(currentPacket);
  const fc = allFrictionCircle(currentPacket);
  const bal = steerBalance(currentPacket);
  const latG = -currentPacket.AccelerationX / 9.81;
  const lonG = -currentPacket.AccelerationZ / 9.81;

  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;

  const states = [
    { l: "FL", ...tireState(ws.fl.state, ws.fl.slipRatio, currentPacket.TireSlipAngleFL), temp: tireTempLabel(units.toTempC(currentPacket.TireTempFL), units.thresholds) },
    { l: "FR", ...tireState(ws.fr.state, ws.fr.slipRatio, currentPacket.TireSlipAngleFR), temp: tireTempLabel(units.toTempC(currentPacket.TireTempFR), units.thresholds) },
    { l: "RL", ...tireState(ws.rl.state, ws.rl.slipRatio, currentPacket.TireSlipAngleRL), temp: tireTempLabel(units.toTempC(currentPacket.TireTempRL), units.thresholds) },
    { l: "RR", ...tireState(ws.rr.state, ws.rr.slipRatio, currentPacket.TireSlipAngleRR), temp: tireTempLabel(units.toTempC(currentPacket.TireTempRR), units.thresholds) },
  ];

  const speedMph = currentPacket.Speed * 2.23694;
  const angleColor = (rad: number) => {
    const deg = Math.abs(rad * (180 / Math.PI));
    const sf = Math.max(0.3, Math.min(1, speedMph / 80));
    if (deg < 4 / sf) return "#34d399";
    if (deg < 8 / sf) return "#fbbf24";
    if (deg < 14 / sf) return "#fb923c";
    return "#ef4444";
  };
  const fmt = (rad: number) => (rad * (180 / Math.PI)).toFixed(1);

  const slipTitle = (
    <span className="flex items-center gap-1 group relative">
      Slip
      <Info className="w-3 h-3 text-app-text-dim cursor-help inline" />
      <span className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary whitespace-nowrap z-10 pointer-events-none normal-case tracking-normal">
        Ratio: wheel speed vs ground speed<br />Angle: direction vs travel (6-12° = peak grip)
      </span>
    </span>
  );

  // Balance chart: map combined balance ∈ [-1, +1] → x ∈ [0, 200].
  // Threshold bands at ±0.3 (classify threshold in steerBalance).
  const BAL_RANGE = 1.0;
  const BAL_THR = 0.3;
  const balX = (d: number) =>
    Math.max(0, Math.min(200, 100 + (d / BAL_RANGE) * 100));
  const thrLeftX = balX(-BAL_THR);
  const thrRightX = balX(BAL_THR);
  const currentX = balX(bal.balance);

  return (
    <div className="text-[11px] font-mono space-y-1.5 mb-3">
      {/* Balance */}
      <div className="flex justify-between">
        <span className="flex items-center gap-1 group relative text-app-text-muted">
          Balance
          <Info className="w-3 h-3 text-app-text-dim cursor-help" />
          <span className="absolute left-0 top-full mt-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2.5 py-2 text-[10px] text-app-text-secondary z-50 pointer-events-none normal-case tracking-normal w-[300px]">
            <span className="block mb-1">Yaw rate vs path curvature + front/rear slip-angle delta.</span>
            <span className="block mb-1.5 text-app-text-dim">
              + = understeer (front slip &gt; rear)<br />
              − = oversteer (body yawing past Ay/V)<br />
              Gated by |latG| ≥ 0.25g — straight-line wheelspin ignored
            </span>
            <svg viewBox="0 0 200 60" className="w-full h-auto mt-1">
              {/* Colored regions */}
              <rect x="0" y="14" width={thrLeftX} height="18" fill="#ef4444" opacity="0.18" />
              <rect x={thrLeftX} y="14" width={thrRightX - thrLeftX} height="18" fill="#34d399" opacity="0.18" />
              <rect x={thrRightX} y="14" width={200 - thrRightX} height="18" fill="#3b82f6" opacity="0.18" />
              {/* Threshold lines */}
              <line x1={thrLeftX} y1="10" x2={thrLeftX} y2="36" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
              <line x1={thrRightX} y1="10" x2={thrRightX} y2="36" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
              {/* Zero marker */}
              <line x1="100" y1="8" x2="100" y2="38" stroke="currentColor" opacity="0.25" />
              {/* Current position marker */}
              <circle cx={currentX} cy="23" r="4" fill={balanceColor(bal.state)} stroke="#0f172a" strokeWidth="1.2" />
              {/* Region labels */}
              <text x={thrLeftX / 2} y="46" textAnchor="middle" fill="#ef4444" fontSize="7.5" fontWeight="600">OVER</text>
              <text x="100" y="46" textAnchor="middle" fill="#34d399" fontSize="7.5" fontWeight="600">NEUTRAL</text>
              <text x={(thrRightX + 200) / 2} y="46" textAnchor="middle" fill="#3b82f6" fontSize="7.5" fontWeight="600">UNDER</text>
              {/* Tick labels */}
              <text x="0" y="56" textAnchor="start" fill="currentColor" opacity="0.4" fontSize="6.5">−1.0</text>
              <text x={thrLeftX} y="56" textAnchor="middle" fill="currentColor" opacity="0.4" fontSize="6.5">−0.3</text>
              <text x={thrRightX} y="56" textAnchor="middle" fill="currentColor" opacity="0.4" fontSize="6.5">+0.3</text>
              <text x="200" y="56" textAnchor="end" fill="currentColor" opacity="0.4" fontSize="6.5">+1.0</text>
            </svg>
            <span className="block text-[9px] text-app-text-dim mt-1">
              Slip Δ: {bal.slipDelta > 0 ? "+" : ""}{bal.slipDelta.toFixed(1)}° (F {bal.frontSlipDeg.toFixed(1)}° / R {bal.rearSlipDeg.toFixed(1)}°)
            </span>
            <span className="block text-[9px] text-app-text-dim">
              Yaw err: {bal.yawError > 0 ? "+" : ""}{bal.yawError.toFixed(2)} rad/s (path {bal.yawRatePath.toFixed(2)})
            </span>
          </span>
        </span>
        <span className="tabular-nums" style={{ color: balanceColor(bal.state) }}>
          {bal.state === "neutral" ? "Neutral" : bal.state === "understeer" ? "Understeer" : "Oversteer"}
          <span className="text-app-text-dim ml-1">({bal.balance > 0 ? "+" : ""}{bal.balance.toFixed(2)})</span>
        </span>
      </div>

      {/* G-Force */}
      <div className="flex justify-between">
        <span className="text-app-text-muted">G-Force</span>
        <span className="tabular-nums text-app-text">
          Lat {latG > 0 ? "+" : ""}{latG.toFixed(2)}g
          <span className="text-app-text-dim"> </span>
          Lon {lonG > 0 ? "+" : ""}{lonG.toFixed(2)}g
        </span>
      </div>

      {/* Brake Bias (ACC) */}
      {currentPacket.acc && (
        <div className="flex justify-between">
          <span className="text-app-text-muted">Brake Bias</span>
          <span className="tabular-nums text-app-text">
            {(currentPacket.acc.brakeBias * 100).toFixed(1)}%F
          </span>
        </div>
      )}

      {/* Tire state */}
      <WheelTable rows={[
        { label: "Grip Ask", fl: C(`${(fc.fl * 100).toFixed(0)}%`, frictionUtilColor(fc.fl)), fr: C(`${(fc.fr * 100).toFixed(0)}%`, frictionUtilColor(fc.fr)), rl: C(`${(fc.rl * 100).toFixed(0)}%`, frictionUtilColor(fc.rl)), rr: C(`${(fc.rr * 100).toFixed(0)}%`, frictionUtilColor(fc.rr)) },
        { label: "Traction", fl: C(states[0].label, states[0].color), fr: C(states[1].label, states[1].color), rl: C(states[2].label, states[2].color), rr: C(states[3].label, states[3].color) },
        { label: "Temp", fl: C(states[0].temp.label, states[0].temp.color), fr: C(states[1].temp.label, states[1].temp.color), rl: C(states[2].temp.label, states[2].temp.color), rr: C(states[3].temp.label, states[3].temp.color) },
        ...(!isF1 ? [{ label: "Surface", fl: <span className="text-app-text-dim">{currentPacket.WheelOnRumbleStripFL !== 0 ? C("CURB", "#fb923c") : currentPacket.WheelInPuddleDepthFL > 0 ? C(`WET ${(currentPacket.WheelInPuddleDepthFL * 100).toFixed(0)}%`, "#3b82f6") : "—"}</span>, fr: <span className="text-app-text-dim">{currentPacket.WheelOnRumbleStripFR !== 0 ? C("CURB", "#fb923c") : currentPacket.WheelInPuddleDepthFR > 0 ? C(`WET ${(currentPacket.WheelInPuddleDepthFR * 100).toFixed(0)}%`, "#3b82f6") : "—"}</span>, rl: <span className="text-app-text-dim">{currentPacket.WheelOnRumbleStripRL !== 0 ? C("CURB", "#fb923c") : currentPacket.WheelInPuddleDepthRL > 0 ? C(`WET ${(currentPacket.WheelInPuddleDepthRL * 100).toFixed(0)}%`, "#3b82f6") : "—"}</span>, rr: <span className="text-app-text-dim">{currentPacket.WheelOnRumbleStripRR !== 0 ? C("CURB", "#fb923c") : currentPacket.WheelInPuddleDepthRR > 0 ? C(`WET ${(currentPacket.WheelInPuddleDepthRR * 100).toFixed(0)}%`, "#3b82f6") : "—"}</span> }] : []),
      ]} />

      {/* Slip */}
      <WheelTable title={slipTitle} borderTop rows={[
        { label: "Ratio", fl: C(`${(ws.fl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fl.slipRatio)), fr: C(`${(ws.fr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fr.slipRatio)), rl: C(`${(ws.rl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rl.slipRatio)), rr: C(`${(ws.rr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rr.slipRatio)) },
        { label: "Angle", fl: C(`${fmt(currentPacket.TireSlipAngleFL)}°`, angleColor(currentPacket.TireSlipAngleFL)), fr: C(`${fmt(currentPacket.TireSlipAngleFR)}°`, angleColor(currentPacket.TireSlipAngleFR)), rl: C(`${fmt(currentPacket.TireSlipAngleRL)}°`, angleColor(currentPacket.TireSlipAngleRL)), rr: C(`${fmt(currentPacket.TireSlipAngleRR)}°`, angleColor(currentPacket.TireSlipAngleRR)) },
      ]} />
    </div>
  );
}
