import { resolveAnalysisTelemetry } from "@shared/games/analysis-telemetry";
import { tryGetGame } from "@shared/games/registry";
import type { GameId, TelemetryPacket } from "@shared/types";
import { Info } from "lucide-react";
import type { useUnits } from "../../hooks/useUnits";
import { severityRangeColor, signedBalanceColor } from "../../lib/colors";
import { allFrictionCircle, allWheelStates, balanceColor, frictionUtilColor, slipRatioColor, steerBalance, tireState, tireTempLabel } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";

interface Props {
  currentPacket: TelemetryPacket;
  gameId: GameId | undefined;
  units: ReturnType<typeof useUnits>;
}

export function AnalyseDynamicsPanel({ currentPacket, gameId, units }: Props) {
  const analysis = resolveAnalysisTelemetry(gameId ? tryGetGame(gameId) : undefined);
  const ws = allWheelStates(currentPacket);
  const fc = allFrictionCircle(currentPacket);
  const bal = steerBalance(currentPacket);
  const latG = -currentPacket.AccelerationX / 9.81;
  const lonG = -currentPacket.AccelerationZ / 9.81;

  const C = (v: string, color: string) => <span style={{ color }}>{v}</span>;
  const unavailable = <span className="text-app-text-dim">—</span>;
  const vehicleSurface = (() => {
    switch (currentPacket.iracing?.playerTrackSurface) {
      case -1:
        return m.analyse_surface_not_in_world();
      case 0:
        return m.analyse_surface_off_track();
      case 1:
        return m.analyse_surface_pit_stall();
      case 2:
        return m.analyse_surface_approaching_pits();
      case 3:
        return m.analyse_surface_on_track();
      default:
        return m.analyse_surface_unknown();
    }
  })();

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
    return severityRangeColor(deg, [4 / sf, 8 / sf, 14 / sf]);
  };
  const fmt = (rad: number) => (rad * (180 / Math.PI)).toFixed(1);

  const slipTitle = (
    <span className="flex items-center gap-1 group relative">
      {m.label_slip()}
      <Info className="w-3 h-3 text-app-text-dim cursor-help inline" />
      <span className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-app-caption text-app-text-secondary whitespace-nowrap z-10 pointer-events-none normal-case tracking-normal">
        Ratio: wheel speed vs ground speed
        <br />
        Angle: direction vs travel (6-12° = peak grip)
      </span>
    </span>
  );

  // Balance chart: map combined balance ∈ [-1, +1] → x ∈ [0, 200].
  // Threshold bands at ±0.3 (classify threshold in steerBalance).
  const BAL_RANGE = 1.0;
  const BAL_THR = 0.3;
  const balX = (d: number) => Math.max(0, Math.min(200, 100 + (d / BAL_RANGE) * 100));
  const thrLeftX = balX(-BAL_THR);
  const thrRightX = balX(BAL_THR);
  const currentX = balX(bal.balance);

  return (
    <div className="text-app-compact font-mono space-y-1.5 mb-3">
      {/* Balance */}
      <div className="flex justify-between">
        <span className="flex items-center gap-1 group relative text-app-text-muted">
          {m.label_balance()}
          {analysis.balance.source === "unavailable" ? (
            <span className="text-app-caption text-app-text-dim">{m.analyse_unavailable()}</span>
          ) : (
            <>
              <Info className="w-3 h-3 text-app-text-dim cursor-help" />
              <span className="pointer-events-none absolute top-full left-0 z-50 mt-2 hidden w-[min(300px,calc(100vw-2rem))] rounded border border-app-border-input bg-app-surface-alt px-2.5 py-2 text-app-caption text-app-text-secondary normal-case tracking-normal group-hover:block">
                <span className="block mb-1">Yaw rate vs path curvature + front/rear slip-angle delta.</span>
                <span className="block mb-2 text-app-text-dim">
                  + = understeer (front slip &gt; rear) &nbsp;|&nbsp; − = oversteer (body yawing past Ay/V)
                  <br />
                  Gated by |latG| ≥ 0.25g — straight-line wheelspin ignored
                </span>

                {/* Signal breakdown */}
                {(() => {
                  const SIG_RANGE = 1.5;
                  const sigX = (u: number) => Math.max(2, Math.min(198, 100 + (Math.max(-SIG_RANGE, Math.min(SIG_RANGE, u)) / SIG_RANGE) * 98));
                  const slipX = sigX(bal.uSlip);
                  const yawX = sigX(bal.uYaw);
                  const slipColor = signedBalanceColor(bal.uSlip, 0.05);
                  // Yaw signal becomes unreliable at high speed (yawRatePath → 0).
                  // Fade it out proportionally so the user can see why it's discounted.
                  const yawReliability = Math.min(1, bal.yawRatePath / 0.15);
                  const yawColor = signedBalanceColor(bal.uYaw, 0.05);
                  return (
                    <svg viewBox="0 0 200 110" className="w-full h-auto mb-1">
                      {/* ── Signal rows ── */}
                      {[
                        { label: "Slip Δ", x: slipX, color: slipColor, opacity: 1, y: 16, desc: `F ${bal.frontSlipDeg.toFixed(1)}° / R ${bal.rearSlipDeg.toFixed(1)}°` },
                        {
                          label: "Yaw",
                          x: yawX,
                          color: yawColor,
                          opacity: yawReliability,
                          y: 40,
                          desc: `err ${bal.yawError > 0 ? "+" : ""}${bal.yawError.toFixed(2)} r/s (path ${bal.yawRatePath.toFixed(2)})`,
                        },
                      ].map(({ label, x, color, opacity, y, desc }) => (
                        <g key={label} opacity={opacity}>
                          <text x="0" y={y - 4} fill="currentColor" opacity="0.5" fontSize="6.5">
                            {label}
                          </text>
                          <rect x="0" y={y} width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
                          <rect x="0" y={y} width={thrLeftX} height="10" fill="var(--balance-negative)" opacity="0.12" />
                          <rect x={thrLeftX} y={y} width={thrRightX - thrLeftX} height="10" fill="var(--balance-neutral)" opacity="0.12" />
                          <rect x={thrRightX} y={y} width={200 - thrRightX} height="10" fill="var(--balance-positive)" opacity="0.12" />
                          <line x1="100" y1={y} x2="100" y2={y + 10} stroke="currentColor" opacity="0.2" />
                          <line x1={thrLeftX} y1={y} x2={thrLeftX} y2={y + 10} stroke="currentColor" opacity="0.3" strokeDasharray="2,1" />
                          <line x1={thrRightX} y1={y} x2={thrRightX} y2={y + 10} stroke="currentColor" opacity="0.3" strokeDasharray="2,1" />
                          <circle cx={x} cy={y + 5} r="4" fill={color} stroke="var(--app-surface)" strokeWidth="1" />
                          <text x="0" y={y + 20} fill="currentColor" opacity="0.35" fontSize="6">
                            {desc}
                          </text>
                        </g>
                      ))}

                      {/* Yaw low-reliability warning */}
                      {yawReliability < 0.6 && (
                        <text x="200" y="44" textAnchor="end" fill="var(--status-warning)" fontSize="6.5" opacity="0.8">
                          {`↓ unreliable at ${(currentPacket.Speed * 3.6).toFixed(0)} km/h`}
                        </text>
                      )}

                      {/* Conflict / agree badge */}
                      {bal.signalsAgree ? (
                        <text x="100" y="70" textAnchor="middle" fill="var(--status-success)" fontSize="7" fontWeight="var(--font-weight-semibold)">
                          SIGNALS AGREE — blended 50/50
                        </text>
                      ) : (
                        <text x="100" y="70" textAnchor="middle" fill="var(--status-warning)" fontSize="7" fontWeight="var(--font-weight-semibold)">
                          CONFLICT — slip angle used alone
                        </text>
                      )}

                      {/* Combined balance bar */}
                      <text x="0" y="80" fill="currentColor" opacity="0.5" fontSize="6.5">
                        {m.label_combined()}
                      </text>
                      <rect x="0" y="82" width="200" height="10" rx="1" fill="currentColor" opacity="0.06" />
                      <rect x="0" y="82" width={thrLeftX} height="10" fill="var(--balance-negative)" opacity="0.18" />
                      <rect x={thrLeftX} y="82" width={thrRightX - thrLeftX} height="10" fill="var(--balance-neutral)" opacity="0.18" />
                      <rect x={thrRightX} y="82" width={200 - thrRightX} height="10" fill="var(--balance-positive)" opacity="0.18" />
                      <line x1="100" y1="82" x2="100" y2="92" stroke="currentColor" opacity="0.25" />
                      <line x1={thrLeftX} y1="78" x2={thrLeftX} y2="96" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
                      <line x1={thrRightX} y1="78" x2={thrRightX} y2="96" stroke="currentColor" opacity="0.4" strokeDasharray="2,2" />
                      <circle cx={currentX} cy="87" r="4" fill={balanceColor(bal.state)} stroke="var(--app-surface)" strokeWidth="1.2" />
                      <text x={thrLeftX / 2} y="106" textAnchor="middle" fill="var(--balance-negative)" fontSize="7" fontWeight="var(--font-weight-semibold)">
                        {m.dynamics_over()}
                      </text>
                      <text x="100" y="106" textAnchor="middle" fill="var(--balance-neutral)" fontSize="7" fontWeight="var(--font-weight-semibold)">
                        {m.dynamics_neutral()}
                      </text>
                      <text x={(thrRightX + 200) / 2} y="106" textAnchor="middle" fill="var(--balance-positive)" fontSize="7" fontWeight="var(--font-weight-semibold)">
                        {m.dynamics_under()}
                      </text>
                    </svg>
                  );
                })()}
              </span>
            </>
          )}
        </span>
        {analysis.balance.source === "unavailable" ? (
          <span className="text-app-text-dim">{m.analyse_unavailable()}</span>
        ) : (
          <span className="tabular-nums" style={{ color: balanceColor(bal.state) }}>
            {bal.state === "neutral" ? "Neutral" : bal.state === "understeer" ? "Understeer" : "Oversteer"}
            <span className="text-app-text-dim ml-1">
              ({bal.balance > 0 ? "+" : ""}
              {bal.balance.toFixed(2)})
            </span>
          </span>
        )}
      </div>

      {/* G-Force */}
      <div className="flex justify-between">
        <span className="text-app-text-muted">{m.analyse_g_force()}</span>
        <span className="tabular-nums text-app-text">
          Lat {latG > 0 ? "+" : ""}
          {latG.toFixed(2)}g<span className="text-app-text-dim"> </span>
          Lon {lonG > 0 ? "+" : ""}
          {lonG.toFixed(2)}g
        </span>
      </div>

      {/* Brake Bias (ACC) */}
      {currentPacket.acc && (
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_brake_bias()}</span>
          <span className="tabular-nums text-app-text">{(currentPacket.acc.brakeBias * 100).toFixed(1)}%F</span>
        </div>
      )}

      {/* Tire state */}
      <WheelTable
        rows={[
          {
            label: m.analyse_dynamics_grip_ask(),
            fl: analysis.gripDemand.source === "unavailable" ? unavailable : C(`${(fc.fl * 100).toFixed(0)}%`, frictionUtilColor(fc.fl)),
            fr: analysis.gripDemand.source === "unavailable" ? unavailable : C(`${(fc.fr * 100).toFixed(0)}%`, frictionUtilColor(fc.fr)),
            rl: analysis.gripDemand.source === "unavailable" ? unavailable : C(`${(fc.rl * 100).toFixed(0)}%`, frictionUtilColor(fc.rl)),
            rr: analysis.gripDemand.source === "unavailable" ? unavailable : C(`${(fc.rr * 100).toFixed(0)}%`, frictionUtilColor(fc.rr)),
          },
          {
            label: m.analyse_dynamics_traction(),
            fl: analysis.traction.source === "unavailable" ? unavailable : C(states[0].label, states[0].color),
            fr: analysis.traction.source === "unavailable" ? unavailable : C(states[1].label, states[1].color),
            rl: analysis.traction.source === "unavailable" ? unavailable : C(states[2].label, states[2].color),
            rr: analysis.traction.source === "unavailable" ? unavailable : C(states[3].label, states[3].color),
          },
          {
            label: analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot" ? m.analyse_wheels_pit_temp() : m.analyse_dynamics_temp(),
            fl: C(states[0].temp.label, states[0].temp.color),
            fr: C(states[1].temp.label, states[1].temp.color),
            rl: C(states[2].temp.label, states[2].temp.color),
            rr: C(states[3].temp.label, states[3].temp.color),
          },
          ...(analysis.surface.source !== "unavailable" && analysis.surface.display !== "vehicle"
            ? [
                {
                  label: m.analyse_dynamics_surface(),
                  fl: (
                    <span className="text-app-text-dim">
                      {currentPacket.WheelOnRumbleStripFL !== 0
                        ? C(m.analyse_dynamics_curb(), "var(--surface-curb)")
                        : currentPacket.WheelInPuddleDepthFL > 0
                          ? C(`${m.analyse_dynamics_wet()} ${(currentPacket.WheelInPuddleDepthFL * 100).toFixed(0)}%`, "var(--surface-wet)")
                          : "—"}
                    </span>
                  ),
                  fr: (
                    <span className="text-app-text-dim">
                      {currentPacket.WheelOnRumbleStripFR !== 0
                        ? C(m.analyse_dynamics_curb(), "var(--surface-curb)")
                        : currentPacket.WheelInPuddleDepthFR > 0
                          ? C(`${m.analyse_dynamics_wet()} ${(currentPacket.WheelInPuddleDepthFR * 100).toFixed(0)}%`, "var(--surface-wet)")
                          : "—"}
                    </span>
                  ),
                  rl: (
                    <span className="text-app-text-dim">
                      {currentPacket.WheelOnRumbleStripRL !== 0
                        ? C(m.analyse_dynamics_curb(), "var(--surface-curb)")
                        : currentPacket.WheelInPuddleDepthRL > 0
                          ? C(`${m.analyse_dynamics_wet()} ${(currentPacket.WheelInPuddleDepthRL * 100).toFixed(0)}%`, "var(--surface-wet)")
                          : "—"}
                    </span>
                  ),
                  rr: (
                    <span className="text-app-text-dim">
                      {currentPacket.WheelOnRumbleStripRR !== 0
                        ? C(m.analyse_dynamics_curb(), "var(--surface-curb)")
                        : currentPacket.WheelInPuddleDepthRR > 0
                          ? C(`${m.analyse_dynamics_wet()} ${(currentPacket.WheelInPuddleDepthRR * 100).toFixed(0)}%`, "var(--surface-wet)")
                          : "—"}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {analysis.surface.source !== "unavailable" && analysis.surface.display === "vehicle" && (
        <div className="flex justify-between">
          <span className="text-app-text-muted">{m.analyse_dynamics_surface()}</span>
          <span className="text-app-text">{vehicleSurface}</span>
        </div>
      )}

      {/* Slip */}
      <WheelTable
        title={slipTitle}
        borderTop
        rows={[
          {
            label: m.analyse_dynamics_ratio(),
            fl: analysis.slipRatio.source === "unavailable" ? unavailable : C(`${(ws.fl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fl.slipRatio)),
            fr: analysis.slipRatio.source === "unavailable" ? unavailable : C(`${(ws.fr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.fr.slipRatio)),
            rl: analysis.slipRatio.source === "unavailable" ? unavailable : C(`${(ws.rl.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rl.slipRatio)),
            rr: analysis.slipRatio.source === "unavailable" ? unavailable : C(`${(ws.rr.slipRatio * 100).toFixed(0)}%`, slipRatioColor(ws.rr.slipRatio)),
          },
          {
            label: m.analyse_dynamics_angle(),
            fl: analysis.slipAngle.source === "unavailable" ? unavailable : C(`${fmt(currentPacket.TireSlipAngleFL)}°`, angleColor(currentPacket.TireSlipAngleFL)),
            fr: analysis.slipAngle.source === "unavailable" ? unavailable : C(`${fmt(currentPacket.TireSlipAngleFR)}°`, angleColor(currentPacket.TireSlipAngleFR)),
            rl: analysis.slipAngle.source === "unavailable" ? unavailable : C(`${fmt(currentPacket.TireSlipAngleRL)}°`, angleColor(currentPacket.TireSlipAngleRL)),
            rr: analysis.slipAngle.source === "unavailable" ? unavailable : C(`${fmt(currentPacket.TireSlipAngleRR)}°`, angleColor(currentPacket.TireSlipAngleRR)),
          },
        ]}
      />
    </div>
  );
}
