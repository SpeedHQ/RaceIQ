import type { TelemetryPacket, GameId } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import type { LapInsight } from "../../lib/lap-insights";
import type { useUnits } from "../../hooks/useUnits";
import { Info } from "lucide-react";
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
  gameId: GameId | undefined;
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
        <div className="px-3 pt-3 pb-1 shrink-0">
          <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider mb-0 font-semibold">
            Metrics at Cursor
          </h3>
        </div>
      )}

      <div className="p-3 flex-1 min-h-0 overflow-y-auto">
        {sidebarTab === "live" ? (
          <>
            {currentPacket && <MetricsPanel pkt={currentPacket} startFuel={startFuel} gameId={gameId} />}

            {currentPacket && (
              <>
                <div className="flex items-center gap-1 mb-2 mt-3 pt-2 border-t border-app-border group relative">
                  <h3 className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold">Dynamics</h3>
                  <Info className="w-3.5 h-3.5 text-app-text-dim cursor-help" />
                  <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[10px] text-app-text-secondary whitespace-nowrap z-10 pointer-events-none">
                    Grip Ask: % of grip capacity per tire<br />100% = at limit, &gt;100% = exceeding grip
                  </div>
                </div>
                <AnalyseDynamicsPanel
                  currentPacket={currentPacket}
                  currentDisplayPacket={currentDisplayPacket}
                  gameId={gameId}
                  units={units}
                />

                {gameId === "f1-2025" && (
                  <AnalyseF1ErsPanel currentPacket={currentPacket} />
                )}

                <AnalyseTireWheelsPanel
                  currentPacket={currentPacket}
                  currentDisplayPacket={currentDisplayPacket}
                  gameId={gameId}
                  units={units}
                  wearRate={wearRate}
                />

                <AnalyseSuspensionPanel currentPacket={currentPacket} />
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
