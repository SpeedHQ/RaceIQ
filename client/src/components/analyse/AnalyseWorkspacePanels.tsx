import type { ComponentProps, RefObject } from "react";
import { AnalyseAiSidebar } from "./AnalyseAiSidebar";
import { AnalyseChartsPanel, type ChartsPanelHandle } from "./AnalyseChartsPanel";
import { AnalyseDataPanel } from "./AnalyseDataPanel";
import { AnalyseResizeHandle } from "./AnalyseResizeHandle";
import { AnalyseTimelineScrubber } from "./AnalyseTimelineScrubber";
import { AnalyseTopSection } from "./AnalyseTopSection";

type TopSectionProps = ComponentProps<typeof AnalyseTopSection>;
type ResizeHandleProps = ComponentProps<typeof AnalyseResizeHandle>;
type TimelineScrubberProps = ComponentProps<typeof AnalyseTimelineScrubber>;
type ChartsPanelProps = ComponentProps<typeof AnalyseChartsPanel>;
type DataPanelProps = ComponentProps<typeof AnalyseDataPanel>;
type AiSidebarProps = ComponentProps<typeof AnalyseAiSidebar>;

interface AnalyseWorkspacePanelsProps {
  topSectionProps: TopSectionProps;
  resizeHandleProps: ResizeHandleProps;
  timelineScrubberProps: TimelineScrubberProps;
  chartsPanelProps: ChartsPanelProps;
  chartsPanelRef: RefObject<ChartsPanelHandle | null>;
  dataPanelProps: DataPanelProps;
  aiSidebarProps: AiSidebarProps | null;
  displayTelemetryLength: number;
}

export function AnalyseWorkspacePanels({
  topSectionProps,
  resizeHandleProps,
  timelineScrubberProps,
  chartsPanelProps,
  chartsPanelRef,
  dataPanelProps,
  aiSidebarProps,
  displayTelemetryLength,
}: AnalyseWorkspacePanelsProps) {
  return (
    <div className="relative flex flex-none flex-col overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:flex-row @5xl/workspace:overflow-hidden">
      {/* Left: main content (map, charts, scrubber) */}
      <div className="@container/analyse-main flex min-w-0 flex-none flex-col overflow-visible @5xl/workspace:h-full @5xl/workspace:flex-1 @5xl/workspace:overflow-x-hidden @5xl/workspace:overflow-y-auto">
        {/* Top section: Track Map + Metrics */}
        <AnalyseTopSection {...topSectionProps} />

        <AnalyseResizeHandle {...resizeHandleProps} />
        <div className="contents @5xl/workspace:flex @5xl/workspace:min-h-64 @5xl/workspace:flex-1 @5xl/workspace:flex-col">
          {/* Lap time + Timeline scrubber */}
          <AnalyseTimelineScrubber {...timelineScrubberProps} />

          {/* Stacked charts — with own scroll */}
          {displayTelemetryLength > 0 && <AnalyseChartsPanel ref={chartsPanelRef} {...chartsPanelProps} />}
        </div>
      </div>

      {/* Right panel – full height */}
      <AnalyseDataPanel {...dataPanelProps} />

      {/* AI panel — analysis + chat */}
      {aiSidebarProps && <AnalyseAiSidebar {...aiSidebarProps} />}
    </div>
  );
}
