import type { TelemetryPacket, GameId } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { Info } from "lucide-react";
import {
  allWheelStates,
  allFrictionCircle,
  steerBalance,
  balanceChartData,
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
  currentDisplayPacket: DisplayPacket | null;
  gameId: GameId | undefined;
  units: ReturnType<typeof useUnits>;
}

export function AnalyseDynamicsPanel({ currentPacket, currentDisplayPacket, gameId, units }: Props) {
  const isF1 = gameId === "f1-2025";
  const ws = allWheelStates(currentPacket);
  const fc = allFrictionCircle(currentPacket);
  const bal = steerBalance(currentPacket);
  const latG = -currentPacket.AccelerationX / 9.81;
  const lonG = -currentPacket.AccelerationZ / 9.81;

  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;

  const temps = [
    currentDisplayPacket?.DisplayTireTempFL ?? currentPacket.TireTempFL,
    currentDisplayPacket?.DisplayTireTempFR ?? currentPacket.TireTempFR,
    currentDisplayPacket?.DisplayTireTempRL ?? currentPacket.TireTempRL,
    currentDisplayPacket?.DisplayTireTempRR ?? currentPacket.TireTempRR,
  ];
  const states = [
    { l: "FL", ...tireState(ws.fl.state, currentPacket.TireCombinedSlipFL), temp: tireTempLabel(units.toTempC(currentPacket.TireTempFL), units.thresholds) },
    { l: "FR", ...tireState(ws.fr.state, currentPacket.TireCombinedSlipFR), temp: tireTempLabel(units.toTempC(currentPacket.TireTempFR), units.thresholds) },
    { l: "RL", ...tireState(ws.rl.state, currentPacket.TireCombinedSlipRL), temp: tireTempLabel(units.toTempC(currentPacket.TireTempRL), units.thresholds) },
    { l: "RR", ...tireState(ws.rr.state, currentPacket.TireCombinedSlipRR), temp: tireTempLabel(units.toTempC(currentPacket.TireTempRR), units.thresholds) },
  ];

  const surfaceLabel = (rumble: boolean, puddle: number) => {
    if (rumble) return C("CURB", "#fb923c");
    if (puddle > 0) return C(`WET ${(puddle * 100).toFixed(0)}%`, "#3b82f6");
    return <span className="text-app-text-dim">—</span>;
  };

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

  const isMetric = units.unit === "metric";
  const chart = balanceChartData(currentPacket.Speed * 2.23694);

  return (
    <div className="text-[11px] font-mono space-y-1.5 mb-3">
      {/* Balance */}
      <div className="flex justify-between">
        <span className="flex items-center gap-1 group relative text-app-text-muted">
          Balance
          <Info className="w-3 h-3 text-app-text-dim cursor-help" />
          <span className="absolute left-0 top-full mt-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2.5 py-2 text-[10px] text-app-text-secondary z-50 pointer-events-none normal-case tracking-normal w-[280px]">
            <span className="block mb-1">Front vs rear slip angle delta (Milliken method). EMA-smoothed.</span>
            <span className="block mb-1.5 text-app-text-dim">
              +δ = understeer (fronts slide more)<br />
              −δ = oversteer (rears slide more)
            </span>
            <span className="block text-[9px] text-app-text-dim mb-1">Slip Angle Threshold (°) vs Speed ({isMetric ? "km/h" : "mph"})</span>
            <svg viewBox="0 0 200 80" className="w-full h-auto">
              <line x1="30" y1="5" x2="30" y2="65" stroke="currentColor" opacity="0.15" />
              <line x1="30" y1="65" x2="195" y2="65" stroke="currentColor" opacity="0.15" />
              <text x="27" y={chart.degToY(0) + 3} textAnchor="end" fill="currentColor" opacity="0.4" fontSize="7">0°</text>
              {chart.yLabels.map((l, i) => (
                <g key={i}>
                  <line x1="30" y1={l.y} x2="195" y2={l.y} stroke="currentColor" opacity="0.08" strokeDasharray="2,2" />
                  <text x="27" y={l.y + 3} textAnchor="end" fill="currentColor" opacity="0.4" fontSize="7">{l.deg}°</text>
                </g>
              ))}
              {chart.xLabels.map(l => {
                const label = isMetric ? Math.round(l.mph * 1.60934) : l.mph;
                const isLast = l.mph === 90;
                return (
                  <text key={l.mph} x={l.x} y="75" textAnchor="middle" fill="currentColor" opacity="0.4" fontSize="7">
                    {isLast ? `${label} ${isMetric ? "km/h" : "mph"}` : String(label)}
                  </text>
                );
              })}
              <polyline points={chart.polylinePoints} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx={chart.markerX} cy={chart.markerY} r="3" fill="#3b82f6" />
            </svg>
          </span>
        </span>
        <span className="tabular-nums" style={{ color: balanceColor(bal.state) }}>
          {bal.state === "neutral" ? "Neutral" : bal.state === "understeer" ? "Understeer" : "Oversteer"}
          <span className="text-app-text-dim ml-1">({bal.deltaDeg > 0 ? "+" : ""}{bal.deltaDeg.toFixed(1)}°)</span>
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

      {/* Grip / slip ratios — Forza has real data, F1 skips */}
      {!isF1 && (
        <>
          {/* Tire state */}
          <WheelTable rows={[
            { label: "Grip Ask", fl: C(`${(fc.fl * 100).toFixed(0)}%`, frictionUtilColor(fc.fl)), fr: C(`${(fc.fr * 100).toFixed(0)}%`, frictionUtilColor(fc.fr)), rl: C(`${(fc.rl * 100).toFixed(0)}%`, frictionUtilColor(fc.rl)), rr: C(`${(fc.rr * 100).toFixed(0)}%`, frictionUtilColor(fc.rr)) },
            { label: "Traction", fl: C(states[0].label, states[0].color), fr: C(states[1].label, states[1].color), rl: C(states[2].label, states[2].color), rr: C(states[3].label, states[3].color) },
            { label: "Temp", fl: C(states[0].temp.label, states[0].temp.color), fr: C(states[1].temp.label, states[1].temp.color), rl: C(states[2].temp.label, states[2].temp.color), rr: C(states[3].temp.label, states[3].temp.color) },
            { label: "Surface", fl: surfaceLabel(currentPacket.WheelOnRumbleStripFL !== 0, currentPacket.WheelInPuddleDepthFL), fr: surfaceLabel(currentPacket.WheelOnRumbleStripFR !== 0, currentPacket.WheelInPuddleDepthFR), rl: surfaceLabel(currentPacket.WheelOnRumbleStripRL !== 0, currentPacket.WheelInPuddleDepthRL), rr: surfaceLabel(currentPacket.WheelOnRumbleStripRR !== 0, currentPacket.WheelInPuddleDepthRR) },
          ]} />

          {/* Slip */}
          <WheelTable title={slipTitle} borderTop rows={[
            { label: "Ratio", fl: C(`${(ws.fl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fl.slipRatio)), fr: C(`${(ws.fr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fr.slipRatio)), rl: C(`${(ws.rl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rl.slipRatio)), rr: C(`${(ws.rr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rr.slipRatio)) },
            { label: "Angle", fl: C(`${fmt(currentPacket.TireSlipAngleFL)}°`, angleColor(currentPacket.TireSlipAngleFL)), fr: C(`${fmt(currentPacket.TireSlipAngleFR)}°`, angleColor(currentPacket.TireSlipAngleFR)), rl: C(`${fmt(currentPacket.TireSlipAngleRL)}°`, angleColor(currentPacket.TireSlipAngleRL)), rr: C(`${fmt(currentPacket.TireSlipAngleRR)}°`, angleColor(currentPacket.TireSlipAngleRR)) },
          ]} />
        </>
      )}
    </div>
  );
}
