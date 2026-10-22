import { useState } from "react";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { InsightPanel } from "./InsightPanel";
import { SpectateLapTabs } from "./SpectateLapTabs";
import type { SpectateController, ReplaySession } from "../contracts/spectate";

export function SpectateInsightsPanel({ pair, controller }: { pair: ReplaySession; controller: SpectateController }) {
  const [side, setSide] = useState<"a" | "b">("a");
  const selectedSide = side === "b" && pair.b ? "b" : "a";
  const replay = selectedSide === "a" ? pair.a.replay : pair.b!.replay;
  const content = <div className="p-3">
    <InsightPanel key={selectedSide} insights={(replay.insights ?? []) as LapInsight[]} detectorCoverage={replay.detectorCoverage ?? []}
      onJumpToFrame={(index) => controller.seekFrame(selectedSide, index)} />
  </div>;
  return <div data-spectate-insights-side={selectedSide} className="h-full overflow-y-auto">
    {pair.b ? <SpectateLapTabs side={selectedSide} onSideChange={setSide}>{content}</SpectateLapTabs> : content}
  </div>;
}
