import { getGame } from "@shared/games/registry";
import type { LapInsight } from "@shared/racing/analysis/laps/insights/types";
import type { GameId } from "../../../../shared/games/ids";
import { Check, Copy, Info } from "lucide-react";
import { useCallback, useState } from "react";
import type { useUnits } from "../../hooks/useUnits";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { m } from "../../paraglide/messages";
import { InsightPanel } from "../InsightPanel";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AnalyseDynamicsPanel } from "./AnalyseDynamicsPanel";
import { AnalyseF1ErsPanel } from "./AnalyseF1ErsPanel";
import { MetricsPanel } from "./AnalyseMetricsPanel";
import { AnalyseSuspensionPanel } from "./AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "./AnalyseTireWheelsPanel";
import { unavailableAnalyseFeatures } from "../../../../shared/games/metric-contracts";
import { MotecMetricInfoModal } from "./MotecImportModal";

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
  packetNumber: number;
  startFuel: number | undefined;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
  lapInsights: LapInsight[];
  onJumpToFrame: (idx: number) => void;
}
function UnavailableFeaturesTooltip({ frame, gameId }: { frame: SemanticAnalysisFrame; gameId: GameId }) {
  const [open, setOpen] = useState(false);
  const available = new Set<string>();
  for (const [id, state] of Object.entries(frame.states)) if (state === "ok") available.add(id);
  const features = unavailableAnalyseFeatures(getGame(gameId), available);
  if (features.length === 0) return null;
  return (
    <>
      <Button
        variant="plain"
        size="content"
        type="button"
        aria-label="Unavailable features in Analyse"
        onClick={() => setOpen(true)}
        className="text-app-text-dim outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
      >
        <Info className="size-3 cursor-pointer" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" layout="scrollable" overlayClassName="bg-app-bg/60">
          <DialogHeader>
            <DialogTitle className="text-app-heading font-semibold">Unavailable in Analyse</DialogTitle>
          </DialogHeader>
          <ul className="space-y-3 text-app-detail text-app-text-secondary">
            {features.map(({ feature, label, missingSemanticIds }) => (
              <li key={feature}>
                <span className="font-medium">{label}</span>
                {missingSemanticIds.length > 0 && <span className="mt-0.5 block break-words font-mono text-app-caption text-app-text-muted">Missing {missingSemanticIds.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MotecInfoButton({ frame, gameId }: { frame: SemanticAnalysisFrame; gameId: GameId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="plain"
        size="content"
        type="button"
        aria-label="MoTeC import info"
        onClick={() => setOpen(true)}
        className="text-status-warning outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
      >
        <Info className="size-3 cursor-pointer" aria-hidden="true" />
      </Button>
      {open && <MotecMetricInfoModal frame={frame} gameId={gameId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function buildAnalyseClipboardText({ frame, packetNumber }: { frame: SemanticAnalysisFrame; packetNumber: number }): string {
  return JSON.stringify({
    packetNumber,
    values: frame.values,
    states: frame.states,
    freshness: frame.freshness,
  });
}
export function AnalyseDataPanel({ sidebarTab, onSidebarTabChange, currentFrame, packetNumber, startFuel, gameId, units, wearRate, lapInsights, onJumpToFrame }: Props) {
  const [copied, setCopied] = useState(false);
  const handleCopyValues = useCallback(() => {
    if (!currentFrame) return;
    navigator.clipboard.writeText(buildAnalyseClipboardText({ frame: currentFrame, packetNumber }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [currentFrame, packetNumber]);
  return (
    <Tabs
      value={sidebarTab}
      onValueChange={(value) => {
        if (value === "live" || value === "insights") onSidebarTabChange(value);
      }}
      className="flex w-full shrink-0 flex-col border-t border-app-border bg-app-surface/50 @5xl/workspace:h-full @5xl/workspace:w-[clamp(18rem,30cqw,22rem)] @5xl/workspace:border-t-0 @5xl/workspace:border-l"
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
      <TabsContent value="live" className="flex flex-col">
        <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-1">
          <h3 className="mb-0 flex items-center gap-1 text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">
            {m.analyse_metrics_at_cursor()}
            {currentFrame && (currentFrame.source === "motec" ? <MotecInfoButton frame={currentFrame} gameId={gameId} /> : <UnavailableFeaturesTooltip frame={currentFrame} gameId={gameId} />)}
          </h3>
          {currentFrame && (
            <Button type="button" onClick={handleCopyValues} title={m.analyse_copy_values_tooltip()} className="text-app-text-muted transition-colors hover:text-app-text">
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </Button>
          )}
        </div>
        <div className="p-3">
          {currentFrame && <MetricsPanel frame={currentFrame} startFuel={startFuel} gameId={gameId} />}
          {currentFrame && (
            <>
              <div className="mt-3 mb-2 border-t border-app-border pt-2">
                <h3 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.analyse_section_dynamics()}</h3>
              </div>
              <AnalyseDynamicsPanel frame={currentFrame} gameId={gameId} units={units} />
              <AnalyseTireWheelsPanel frame={currentFrame} gameId={gameId} units={units} wearRate={wearRate} />
              <AnalyseSuspensionPanel frame={currentFrame} gameId={gameId} />
              {getGame(gameId).telemetry.ers && <AnalyseF1ErsPanel frame={currentFrame} />}
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
