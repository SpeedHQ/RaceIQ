import { useMemo, useState, type ComponentProps, type RefObject } from "react";
import { semanticNumber } from "@raceiq/scene-3d/semantic-frame";
import { m } from "@/paraglide/messages";
import { SingleReplayWorkspace } from "@raceiq/lap-replay/ui";
import { CarWireframe } from "../CarWireframe";
import { TireDiagram } from "../telemetry/TireDiagram";
import { AnalyseAiSidebar } from "./AnalyseAiSidebar";
import { AnalyseChartsPanel, type ChartsPanelHandle } from "./AnalyseChartsPanel";
import { AnalyseDataContent } from "./AnalyseDataPanel";
import { AnalyseTimelineScrubber } from "./AnalyseTimelineScrubber";
import { AnalyseTrackPanel } from "./AnalyseTrackPanel";

type TrackPanelProps = ComponentProps<typeof AnalyseTrackPanel>;
type SceneProps = Pick<ComponentProps<typeof CarWireframe>, "lmuCarClass" | "source" | "onRuntime">;
interface AnalyseWorkspacePanelsProps {
  trackPanelProps: TrackPanelProps;
  sceneProps: SceneProps;
  timelineScrubberProps: ComponentProps<typeof AnalyseTimelineScrubber>;
  chartsPanelProps: ComponentProps<typeof AnalyseChartsPanel>;
  chartsPanelRef: RefObject<ChartsPanelHandle | null>;
  dataPanelProps: ComponentProps<typeof AnalyseDataContent>;
  insightsProps: ComponentProps<typeof SingleReplayWorkspace>["insightsProps"];
  aiSidebarProps: ComponentProps<typeof AnalyseAiSidebar> | null;
  onAiOpenChange: (open: boolean) => void;
}

export function AnalyseWorkspacePanels({
  trackPanelProps,
  sceneProps,
  timelineScrubberProps,
  chartsPanelProps,
  chartsPanelRef,
  dataPanelProps,
  insightsProps,
  aiSidebarProps,
  onAiOpenChange,
}: AnalyseWorkspacePanelsProps) {
  const [mapOpen, setMapOpen] = useState(true);
  const frames = chartsPanelProps.semanticFrames;
  const lapLine = useMemo(() => {
    const points: { x: number; z: number }[] = [];
    for (const frame of frames) {
      const x = semanticNumber(frame, "motion.position-x");
      const z = semanticNumber(frame, "motion.position-z");
      if (x != null && z != null) points.push({ x, z });
    }
    return points.length > 2 ? points : null;
  }, [frames]);
  return (
    <SingleReplayWorkspace
      telemetry={<AnalyseChartsPanel ref={chartsPanelRef} {...chartsPanelProps} />}
      carLayout={<div className="h-full overflow-y-auto p-2">{dataPanelProps.currentFrame && <TireDiagram frame={dataPanelProps.currentFrame} gameId={dataPanelProps.gameId} />}</div>}
      data={<div className="h-full overflow-y-auto"><AnalyseDataContent {...dataPanelProps} /></div>}
      insightsProps={insightsProps}
      ai={aiSidebarProps && <AnalyseAiSidebar {...aiSidebarProps} />}
      aiOpen={aiSidebarProps != null}
      onAiOpenChange={onAiOpenChange}
      scene={
      <div data-replay-scene="" className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
        <CarWireframe gameId={dataPanelProps.gameId} frame={frames[0]!} telemetry={frames} cursorIdx={0}
          outline={lapLine} boundaries={trackPanelProps.boundaries} tempLabel={dataPanelProps.units.tempLabel} {...sceneProps} />
        </div>
        <button type="button" aria-expanded={mapOpen} aria-controls="replay-track-overview" onClick={() => setMapOpen((open) => !open)}
          className="absolute top-2 right-2 z-10 rounded border border-app-border bg-app-bg px-2 py-1 text-app-caption focus-visible:outline-2 focus-visible:outline-app-accent">
          {m.spectate_overview()}
        </button>
        {mapOpen && <div id="replay-track-overview" className="absolute top-12 right-2 h-56 w-64 max-w-[70%] overflow-hidden rounded border border-app-border bg-app-bg/90">
          <AnalyseTrackPanel {...trackPanelProps} />
        </div>}
      </div>
      }
      playback={<AnalyseTimelineScrubber {...timelineScrubberProps} />}
    />
  );
}
