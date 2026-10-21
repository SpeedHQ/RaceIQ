import { useState } from "react";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { InsightPanel } from "./InsightPanel";
import { SpectateLapTabs } from "./SpectateLapTabs";
import type { SpectateController, SpectatePair } from "../contracts/spectate";

export function SpectateInsightsPanel({ pair, controller }: { pair: SpectatePair; controller: SpectateController }) {
  const [side, setSide] = useState<"a" | "b">("a");
  const replay = pair[side].replay;
  return <div data-spectate-insights-side={side} className="h-full overflow-y-auto">
    <SpectateLapTabs side={side} onSideChange={setSide}>
      <div className="p-3">
        <InsightPanel key={side} insights={(replay.insights ?? []) as LapInsight[]} detectorCoverage={replay.detectorCoverage ?? []}
          onJumpToFrame={(index) => controller.seekFrame(side, index)} />
      </div>
    </SpectateLapTabs>
  </div>;
}
