import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import type { TelemetryPacket, GameId } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import type { LapInsight } from "../../lib/lap-insights";
import type { useUnits } from "../../hooks/useUnits";
import { getSteeringLock } from "../Settings";
import { MetricsPanel } from "./AnalyseMetricsPanel";
import { AnalyseDynamicsPanel } from "./AnalyseDynamicsPanel";
import { AnalyseF1ErsPanel } from "./AnalyseF1ErsPanel";
import { AnalyseTireWheelsPanel } from "./AnalyseTireWheelsPanel";
import { AnalyseSuspensionPanel } from "./AnalyseSuspensionPanel";
import { InsightPanel } from "../InsightPanel";

interface WearRate {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

interface Props {
  sidebarTab: "live" | "insights";
  onSidebarTabChange: (tab: "live" | "insights") => void;
  currentPacket: TelemetryPacket | null;
  currentDisplayPacket: DisplayPacket | null;
  startFuel: number | undefined;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
  lapInsights: LapInsight[];
  onJumpToFrame: (idx: number) => void;
}

export function AnalyseDataPanel({
  sidebarTab, onSidebarTabChange,
  currentPacket, currentDisplayPacket, startFuel,
  gameId, units, wearRate,
  lapInsights, onJumpToFrame,
}: Props) {
  const [copied, setCopied] = useState(false);
  const handleCopyValues = useCallback(() => {
    if (!currentPacket) return;
    const pkt = currentPacket;
    const dp = currentDisplayPacket;
    const speed = dp?.DisplaySpeed ?? pkt.Speed;
    const throttlePct = ((pkt.Accel / 255) * 100).toFixed(0);
    const brakePct = ((pkt.Brake / 255) * 100).toFixed(0);
    const lock = getSteeringLock();
    const steerDeg = (pkt.Steer / 127) * (lock / 2);

    const lines: string[] = [
      `Speed: ${speed.toFixed(0)} ${units.speedLabel}`,
      `RPM: ${pkt.CurrentEngineRpm.toFixed(0)}`,
      `Gear: ${pkt.Gear}`,
      `Throttle: ${throttlePct}%`,
      `Brake: ${brakePct}%`,
      `Steer: ${steerDeg > 0 ? "+" : ""}${steerDeg.toFixed(0)}°`,
    ];
    if (gameId === "fm-2023" || pkt.Boost > 0) lines.push(`Boost: ${pkt.Boost.toFixed(1)} psi`);
    if (gameId === "fm-2023" || pkt.Power > 0) lines.push(`Power: ${(pkt.Power / 745.7).toFixed(0)} hp`);
    if (gameId === "fm-2023" || pkt.Torque > 0) lines.push(`Torque: ${pkt.Torque.toFixed(0)} Nm`);
    lines.push(`Fuel: ${(pkt.Fuel * 100).toFixed(1)}%`);

    // Dynamics
    lines.push("", "--- Dynamics ---");
    lines.push(`G-Force Lat: ${pkt.AccelerationX.toFixed(2)}g`);
    lines.push(`G-Force Lon: ${pkt.AccelerationZ.toFixed(2)}g`);

    // Tire temps
    const tFL = dp?.DisplayTireTempFL ?? pkt.TireTempFL;
    const tFR = dp?.DisplayTireTempFR ?? pkt.TireTempFR;
    const tRL = dp?.DisplayTireTempRL ?? pkt.TireTempRL;
    const tRR = dp?.DisplayTireTempRR ?? pkt.TireTempRR;
    lines.push("", "--- Tire Temps ---");
    lines.push(`FL: ${tFL.toFixed(0)}  FR: ${tFR.toFixed(0)}`);
    lines.push(`RL: ${tRL.toFixed(0)}  RR: ${tRR.toFixed(0)}`);

    // Tire wear
    lines.push("", "--- Tire Wear ---");
    lines.push(`FL: ${((1 - pkt.TireWearFL) * 100).toFixed(1)}%  FR: ${((1 - pkt.TireWearFR) * 100).toFixed(1)}%`);
    lines.push(`RL: ${((1 - pkt.TireWearRL) * 100).toFixed(1)}%  RR: ${((1 - pkt.TireWearRR) * 100).toFixed(1)}%`);

    // Suspension
    lines.push("", "--- Suspension Travel ---");
    lines.push(`FL: ${(pkt.NormSuspensionTravelFL * 100).toFixed(0)}%  FR: ${(pkt.NormSuspensionTravelFR * 100).toFixed(0)}%`);
    lines.push(`RL: ${(pkt.NormSuspensionTravelRL * 100).toFixed(0)}%  RR: ${(pkt.NormSuspensionTravelRR * 100).toFixed(0)}%`);

    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [currentPacket, currentDisplayPacket, gameId, units]);

  return (
    <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
      {/* Tab switcher */}
      <div className="flex border-b border-app-border shrink-0">
        <button
          onClick={() => onSidebarTabChange("live")}
          className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
            sidebarTab === "live"
              ? "text-app-text border-b-2 border-app-accent"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Data
        </button>
        <button
          onClick={() => onSidebarTabChange("insights")}
          className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
            sidebarTab === "insights"
              ? "text-app-text border-b-2 border-app-accent"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Insights
          {lapInsights.length > 0 && (
            <span className="ml-1 text-[9px] bg-app-border-input text-app-text rounded-full px-1.5">
              {lapInsights.length}
            </span>
          )}
        </button>
      </div>

      {sidebarTab === "live" && (
        <div className="px-3 pt-3 pb-1 shrink-0 flex items-center justify-between">
          <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0 font-semibold">
            Metrics at Cursor
          </h3>
          {currentPacket && (
            <button
              onClick={handleCopyValues}
              title="Copy values at cursor"
              className="text-app-text-muted hover:text-app-text transition-colors"
            >
              {copied ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
            </button>
          )}
        </div>
      )}

      <div className="p-3 flex-1 min-h-0 overflow-y-auto">
        {sidebarTab === "live" ? (
          <>
            {currentPacket && <MetricsPanel pkt={currentPacket} startFuel={startFuel} gameId={gameId} />}

            {currentPacket && (
              <>
                <div className="mb-2 mt-3 pt-2 border-t border-app-border">
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold">Dynamics</h3>
                </div>
                <AnalyseDynamicsPanel
                  currentPacket={currentPacket}
                  gameId={gameId}
                  units={units}
                />

                <AnalyseTireWheelsPanel
                  currentPacket={currentPacket}
                  currentDisplayPacket={currentDisplayPacket}
                  gameId={gameId}
                  units={units}
                  wearRate={wearRate}
                />

                <AnalyseSuspensionPanel currentPacket={currentPacket} />

                {gameId === "f1-2025" && (
                  <AnalyseF1ErsPanel currentPacket={currentPacket} />
                )}
              </>
            )}
          </>
        ) : (
          <InsightPanel insights={lapInsights} onJumpToFrame={onJumpToFrame} />
        )}
      </div>
    </div>
  );
}
