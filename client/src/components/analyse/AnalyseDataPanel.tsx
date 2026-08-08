import type { LapInsight } from "@shared/racing/analysis/laps/insights/types";
import type { GameId } from "../../../../shared/games/ids";
import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import { m } from "../../paraglide/messages";
import { InsightPanel } from "../InsightPanel";
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
  currentFrame: SemanticAnalysisFrame | null;
  startFuel: number | undefined;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
  lapInsights: LapInsight[];
  onJumpToFrame: (idx: number) => void;
}

export function AnalyseDataPanel({ sidebarTab, onSidebarTabChange, currentFrame, startFuel, gameId, units, wearRate, lapInsights, onJumpToFrame }: Props) {
  const [copied, setCopied] = useState(false);
  const handleCopyValues = useCallback(() => {
    if (!currentFrame) return;
    const speed = currentFrame.values["motion.speed"];
    navigator.clipboard.writeText(typeof speed === "number" ? `Speed: ${units.speed(speed).toFixed(0)} ${units.speedLabel}` : "Speed: Unavailable");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [currentFrame, units]);
  return (
    <Tabs
      value={sidebarTab}
      onValueChange={(value) => {
        if (value === "live" || value === "insights") onSidebarTabChange(value);
      }}
      className="flex h-[34rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface/50 @5xl/workspace:h-full @5xl/workspace:w-[clamp(18rem,30cqw,22rem)] @5xl/workspace:border-t-0 @5xl/workspace:border-l"
    >
      <TabsList variant="underline" className="w-full shrink-0">
        <TabsTrigger value="live" className="flex-1">
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
          {currentFrame && (
            <Button type="button" onClick={handleCopyValues} title={m.analyse_copy_values_tooltip()} className="text-app-text-muted transition-colors hover:text-app-text">
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {currentFrame && <MetricsPanel frame={currentFrame} startFuel={startFuel} />}

          {currentFrame && (
            <>
              <div className="mt-3 mb-2 border-t border-app-border pt-2">
                <h3 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_section_dynamics()}</h3>
              </div>
              <AnalyseDynamicsPanel frame={currentFrame} gameId={gameId} units={units} />

              <AnalyseTireWheelsPanel frame={currentFrame} gameId={gameId} units={units} wearRate={wearRate} />

              <AnalyseSuspensionPanel frame={currentFrame} />

              <AnalyseF1ErsPanel frame={currentFrame} />
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
