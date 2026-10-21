import type { ComponentProps, ReactNode } from "react";
import { useLocalStorage, useMessages } from "./host";
import { InsightPanel } from "./InsightPanel";
import { SpectateWorkspace } from "./SpectateWorkspace";

export function SingleReplayWorkspace({ scene, playback, telemetry, carLayout, data, insightsProps, ai, aiOpen, onAiOpenChange }: {
  scene: ReactNode;
  playback: ReactNode;
  telemetry: ReactNode;
  carLayout: ReactNode;
  data: ReactNode;
  insightsProps: ComponentProps<typeof InsightPanel>;
  ai: ReactNode;
  aiOpen: boolean;
  onAiOpenChange: (open: boolean) => void;
}) {
  const m = useMessages();
  const [telemetryOpen, setTelemetryOpen] = useLocalStorage("replay-telemetry-open", false);
  const [carOpen, setCarOpen] = useLocalStorage("replay-car-open", false);
  const [dataOpen, setDataOpen] = useLocalStorage("replay-data-open", true);
  const [insightsOpen, setInsightsOpen] = useLocalStorage("replay-insights-open", false);
  return <SpectateWorkspace storageKey="replay-panel-width" panels={[
    { id: "replay-telemetry-panel", label: m.spectate_telemetry(), open: telemetryOpen, closedWidth: 100, toggle: setTelemetryOpen, resizable: true, content: telemetry },
    { id: "replay-car-panel", label: "Car layout", open: carOpen, width: 384, closedWidth: 88, toggle: setCarOpen, content: carLayout },
    { id: "replay-data-panel", label: m.analyse_tab_data(), open: dataOpen, width: 384, closedWidth: 72, toggle: setDataOpen, content: data },
    { id: "replay-insights-panel", label: m.analyse_tab_insights(), open: insightsOpen, width: 384, closedWidth: 88, toggle: setInsightsOpen,
      content: <div className="h-full overflow-y-auto p-3"><InsightPanel {...insightsProps} /></div> },
    { id: "replay-ai-panel", label: m.label_ai_analysis(), open: aiOpen, closedWidth: 112, toggle: onAiOpenChange, content: ai },
  ]}>
    {scene}
    {playback}
  </SpectateWorkspace>;
}
