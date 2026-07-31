import { resolveAnalysisTelemetry } from "@shared/games/analysis-telemetry";
import { getGame } from "@shared/games/registry";
import { getFuelDisplay, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { GameId, TelemetryPacket } from "@shared/types";
import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { DisplayPacket } from "../../lib/convert-packet";
import type { LapInsight } from "../../lib/lap-insights";
import { m } from "../../paraglide/messages";
import { InsightPanel } from "../InsightPanel";
import { Button } from "../ui/button";
import { getSteeringLock } from "../Settings";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AnalyseDynamicsPanel } from "./AnalyseDynamicsPanel";
import { AnalyseF1ErsPanel } from "./AnalyseF1ErsPanel";
import { MetricsPanel } from "./AnalyseMetricsPanel";
import { AnalyseSuspensionPanel } from "./AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "./AnalyseTireWheelsPanel";

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

export function AnalyseDataPanel({ sidebarTab, onSidebarTabChange, currentPacket, currentDisplayPacket, startFuel, gameId, units, wearRate, lapInsights, onJumpToFrame }: Props) {
  const [copied, setCopied] = useState(false);
  const adapter = getGame(gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const telemetryModel = adapter.telemetry;
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
    if (telemetryModel.boost) lines.push(`Boost: ${pkt.Boost.toFixed(1)} psi`);
    if (telemetryModel.power) lines.push(`Power: ${(pkt.Power / WATTS_PER_HORSEPOWER).toFixed(0)} hp`);
    if (telemetryModel.torque) lines.push(`Torque: ${pkt.Torque.toFixed(0)} Nm`);
    const fuel = getFuelDisplay(pkt, telemetryModel.fuel);
    lines.push(`Fuel: ${fuel.amount.toFixed(1)}${fuel.unit}`);

    // Dynamics
    lines.push("", "--- Dynamics ---");
    lines.push(`G-Force Lat: ${(-pkt.AccelerationX / 9.81).toFixed(2)}g`);
    lines.push(`G-Force Lon: ${(-pkt.AccelerationZ / 9.81).toFixed(2)}g`);

    // Tire temps
    const tFL = dp?.DisplayTireTempFL ?? pkt.TireTempFL;
    const tFR = dp?.DisplayTireTempFR ?? pkt.TireTempFR;
    const tRL = dp?.DisplayTireTempRL ?? pkt.TireTempRL;
    const tRR = dp?.DisplayTireTempRR ?? pkt.TireTempRR;
    const tireTemperatureHeading = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot" ? "Last Pit Tire Temps" : "Tire Temps";
    lines.push("", `--- ${tireTemperatureHeading} ---`);
    lines.push(`FL: ${tFL.toFixed(0)}  FR: ${tFR.toFixed(0)}`);
    lines.push(`RL: ${tRL.toFixed(0)}  RR: ${tRR.toFixed(0)}`);

    // Tire wear
    const tireHealthHeading = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot" ? "Last Pit Tire Health" : "Tire Health";
    lines.push("", `--- ${tireHealthHeading} ---`);
    lines.push(`FL: ${((1 - pkt.TireWearFL) * 100).toFixed(1)}%  FR: ${((1 - pkt.TireWearFR) * 100).toFixed(1)}%`);
    lines.push(`RL: ${((1 - pkt.TireWearRL) * 100).toFixed(1)}%  RR: ${((1 - pkt.TireWearRR) * 100).toFixed(1)}%`);

    // Suspension
    lines.push("", "--- Suspension Travel ---");
    if (analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.display === "millimeters") {
      lines.push(`FL: ${(pkt.SuspensionTravelMFL * 1000).toFixed(0)}mm  FR: ${(pkt.SuspensionTravelMFR * 1000).toFixed(0)}mm`);
      lines.push(`RL: ${(pkt.SuspensionTravelMRL * 1000).toFixed(0)}mm  RR: ${(pkt.SuspensionTravelMRR * 1000).toFixed(0)}mm`);
    } else {
      lines.push(`FL: ${(pkt.NormSuspensionTravelFL * 100).toFixed(0)}%  FR: ${(pkt.NormSuspensionTravelFR * 100).toFixed(0)}%`);
      lines.push(`RL: ${(pkt.NormSuspensionTravelRL * 100).toFixed(0)}%  RR: ${(pkt.NormSuspensionTravelRR * 100).toFixed(0)}%`);
    }

    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [analysis, currentPacket, currentDisplayPacket, telemetryModel, units]);

  return (
    <div className="flex h-[34rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface/50 @5xl/workspace:h-full @5xl/workspace:w-[clamp(18rem,30cqw,22rem)] @5xl/workspace:border-t-0 @5xl/workspace:border-l">
      {/* Tab switcher */}
      <div className="flex border-b border-app-border shrink-0">
        <button
          type="button"
          onClick={() => onSidebarTabChange("live")}
          className={`flex-1 py-1.5 text-app-caption uppercase tracking-wider font-semibold transition-colors ${
            sidebarTab === "live" ? "text-app-text border-b-2 border-app-accent" : "text-app-text-muted hover:text-app-text"
          }`}
        >
          {m.analyse_tab_data()}
        </TabsTrigger>
        <TabsTrigger value="insights" className="flex-1">
          {m.analyse_tab_insights()}
          {lapInsights.length > 0 && <span className="ml-1 rounded-full bg-app-border-input px-1.5 text-app-micro text-app-text">{lapInsights.length}</span>}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="live" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-1">
          <h3 className="mb-0 text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_metrics_at_cursor()}</h3>
          {currentPacket && (
            <Button
              type="button"
              variant="app-ghost"
              size="app-sm"
              onClick={handleCopyValues}
              title={m.analyse_copy_values_tooltip()}
              className="!p-0"
            >
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {currentPacket && <MetricsPanel pkt={currentPacket} startFuel={startFuel} />}

          {currentPacket && (
            <>
              <div className="mt-3 mb-2 border-t border-app-border pt-2">
                <h3 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_section_dynamics()}</h3>
              </div>
              <AnalyseDynamicsPanel currentPacket={currentPacket} gameId={gameId} units={units} />

              <AnalyseTireWheelsPanel currentPacket={currentPacket} currentDisplayPacket={currentDisplayPacket} gameId={gameId} units={units} wearRate={wearRate} />

              <AnalyseSuspensionPanel currentPacket={currentPacket} />

              {telemetryModel.ers && <AnalyseF1ErsPanel currentPacket={currentPacket} />}
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value="insights" className="min-h-0 flex-1 overflow-y-auto p-3">
        <InsightPanel insights={lapInsights} onJumpToFrame={onJumpToFrame} />
      </TabsContent>
    </Tabs>
  );
}
