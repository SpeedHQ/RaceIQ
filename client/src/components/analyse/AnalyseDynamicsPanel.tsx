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
            <span className="block mb-2 text-app-text-dim">
              + = understeer (front slip &gt; rear) &nbsp;|&nbsp; − = oversteer (body yawing past Ay/V)<br />
              Gated by |latG| ≥ 0.25g — straight-line wheelspin ignored
            </span>

            {/* Signal breakdown */}
            {(() => {
              const SIG_RANGE = 1.5;
              const sigX = (u: number) => Math.max(2, Math.min(198, 100 + (Math.max(-SIG_RANGE, Math.min(SIG_RANGE, u)) / SIG_RANGE) * 98));
              const slipX = sigX(bal.uSlip);
              const yawX  = sigX(bal.uYaw);
              const slipColor = bal.uSlip > 0.05 ? "#3b82f6" : bal.uSlip < -0.05 ? "#ef4444" : "#34d399";
              // Yaw signal becomes unreliable at high speed (yawRatePath → 0).
              // Fade it out proportionally so the user can see why it's discounted.
              const yawReliability = Math.min(1, bal.yawRatePath / 0.15);
              const yawColor = bal.uYaw > 0.05 ? "#3b82f6" : bal.uYaw < -0.05 ? "#ef4444" : "#34d399";
              return (
                <svg viewBox="0 0 200 110" className="w-full h-auto mb-1">
                  {/* ── Signal rows ── */}
                  {[
                    { label: "Slip Δ", x: slipX, color: slipColor, opacity: 1,              y: 16, desc: `F ${bal.frontSlipDeg.toFixed(1)}° / R ${bal.rearSlipDeg.toFixed(1)}°` },
                    { label: "Yaw",    x: yawX,  color: yawColor,  opacity: yawReliability, y: 40, desc: `err ${bal.yawError > 0 ? "+" : ""}${bal.yawError.toFixed(2)} r/s (path ${bal.yawRatePath.toFixed(2)})` },
                  ].map(({ label, x, color, opacity, y, desc }) => (
                    <g key={label} opacity={opacity}>
                      <text x="0" y={y - 4} fill="currentColor" opacity="0.5" fontSize="6.5">{label}</text>
                      <rect x="0" y={y} width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
                      <rect x="0" y={y} width={thrLeftX} height="10" fill="#ef4444" opacity="0.12" />
                      <rect x={thrLeftX} y={y} width={thrRightX - thrLeftX} height="10" fill="#34d399" opacity="0.12" />
                      <rect x={thrRightX} y={y} width={200 - thrRightX} height="10" fill="#3b82f6" opacity="0.12" />
                      <line x1="100" y1={y} x2="100" y2={y + 10} stroke="currentColor" opacity="0.2" />
                      <line x1={thrLeftX} y1={y} x2={thrLeftX} y2={y + 10} stroke="currentColor" opacity="0.3" strokeDasharray="2,1" />
                      <line x1={thrRightX} y1={y} x2={thrRightX} y2={y + 10} stroke="currentColor" opacity="0.3" strokeDasharray="2,1" />
                      <circle cx={x} cy={y + 5} r="4" fill={color} stroke="#0f172a" strokeWidth="1" />
                      <text x="0" y={y + 20} fill="currentColor" opacity="0.35" fontSize="6">{desc}</text>
                    </g>
                  ))}

                  {/* Yaw low-reliability warning */}
                  {yawReliability < 0.6 && (
                    <text x="200" y="44" textAnchor="end" fill="#fbbf24" fontSize="6.5" opacity="0.8">
                      {`↓ unreliable at ${(currentPacket.Speed * 3.6).toFixed(0)} km/h`}
                    </text>
                  )}

                  {/* Conflict / agree badge */}
                  {bal.signalsAgree
                    ? <text x="100" y="70" textAnchor="middle" fill="#34d399" fontSize="7" fontWeight="600">SIGNALS AGREE — blended 50/50</text>
                    : <text x="100" y="70" textAnchor="middle" fill="#fbbf24" fontSize="7" fontWeight="600">CONFLICT — slip angle used alone</text>
                  }

                  {/* Combined balance bar */}
                  <text x="0" y="80" fill="currentColor" opacity="0.5" fontSize="6.5">Combined</text>
                  <rect x="0" y="82" width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
                  <rect x="0" y="82" width={thrLeftX} height="10" fill="#ef4444" opacity="0.18" />
                  <rect x={thrLeftX} y="82" width={thrRightX - thrLeftX} height="10" fill="#34d399" opacity="0.18" />
                  <rect x={thrRightX} y="82" width={200 - thrRightX} height="10" fill="#3b82f6" opacity="0.18" />
                  <line x1="100" y1="82" x2="100" y2="92" stroke="currentColor" opacity="0.25" />
                  <line x1={thrLeftX} y1="78" x2={thrLeftX} y2="96" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
                  <line x1={thrRightX} y1="78" x2={thrRightX} y2="96" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
                  <circle cx={currentX} cy="87" r="4" fill={balanceColor(bal.state)} stroke="#0f172a" strokeWidth="1.2" />
                  <text x={thrLeftX / 2} y="106" textAnchor="middle" fill="#ef4444" fontSize="7" fontWeight="600">OVER</text>
                  <text x="100" y="106" textAnchor="middle" fill="#34d399" fontSize="7" fontWeight="600">NEUTRAL</text>
                  <text x={(thrRightX + 200) / 2} y="106" textAnchor="middle" fill="#3b82f6" fontSize="7" fontWeight="600">UNDER</text>
                </svg>
              );
            })()}
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
