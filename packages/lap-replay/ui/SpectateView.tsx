import { useCompareLineSpread } from "./host"
import { SpectateLineScore } from "./SpectateLineScore";
import { useMemo, useState } from "react";
import { useMessages } from "./host"
import { CompareAiPanel } from "./host"
import { useReplayHost } from "./host"
import { SpectateScene } from "./SpectateScene";
import { SpectateTelemetryPanel } from "./SpectateTelemetryPanel";
import { SpectateCarPanel } from "./SpectateCarPanel";
import { SpectateOverview } from "./SpectateOverview";
import { SpectateInputs } from "./SpectateInputs";
import { SpectatePlayback } from "./SpectatePlayback";
import type { SpectateController, SpectatePair, SpectateSegment } from "../contracts/spectate";
import { buildSpectateFocus, type SpectateFocusMode } from "./spectate-focus";
import { SpectateFocusToolbar } from "./SpectateFocusToolbar";
import { SpectateDataPanel } from "./SpectateDataPanel";
import { SpectateInsightsPanel } from "./SpectateInsightsPanel";
import { useLocalStorage } from "./host"
import { SpectateWorkspace } from "./SpectateWorkspace"
export function SpectateView({
  pair,
  controller,
  outline,
  segments,
  aiOpen,
  telemetryOpen,
  carPanelOpen,
  onTelemetryOpenChange,
  onCarPanelOpenChange,
  panelHeaderTarget,
  onAiOpenChange,
}: {
  pair: SpectatePair;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
  aiOpen: boolean;
  telemetryOpen: boolean;
  carPanelOpen: boolean;
  onTelemetryOpenChange: (open: boolean) => void;
  onCarPanelOpenChange: (open: boolean) => void;
  panelHeaderTarget: HTMLDivElement | null;
  onAiOpenChange: (open: boolean) => void;
}) { const { formatLapTime } = useReplayHost(); const m = useMessages(); const lineSpread = useCompareLineSpread(pair.gameId, [pair.comparison.lapA.id, pair.comparison.lapB.id]);
const [focusMode, setFocusMode] = useState<SpectateFocusMode>("inputs");
const focus = useMemo(() => buildSpectateFocus(pair, focusMode), [pair, focusMode]);
const [telemetryHeaderControls, setTelemetryHeaderControls] = useState<HTMLDivElement | null>(null);
const [aiHeaderControls, setAiHeaderControls] = useState<HTMLDivElement | null>(null);
const [dataOpen, setDataOpen] = useLocalStorage("spectate-data-open", false);
const [insightsOpen, setInsightsOpen] = useLocalStorage("spectate-insights-open", false);
return (
  <SpectateWorkspace storageKey="spectate-panel-width" panelHeaderTarget={panelHeaderTarget} tallMobile={pair.gameId === "f1-2025"} panels={[
    { id: "spectate-telemetry-panel", label: m.spectate_telemetry(), open: telemetryOpen, closedWidth: 100, toggle: onTelemetryOpenChange, resizable: true,
      headerControls: <div ref={setTelemetryHeaderControls} className="shrink-0 pr-3" />,
      content: <SpectateTelemetryPanel pair={pair} controller={controller} headerTarget={telemetryHeaderControls} /> },
    { id: "spectate-2d-panel", label: "Car layout", open: carPanelOpen, width: 384, closedWidth: 88, toggle: onCarPanelOpenChange,
      content: <SpectateCarPanel pair={pair} controller={controller} /> },
    { id: "spectate-data-panel", label: m.analyse_tab_data(), open: dataOpen, width: 384, closedWidth: 72, toggle: setDataOpen,
      content: <div className="h-full overflow-y-auto"><SpectateDataPanel pair={pair} controller={controller} /></div> },
    { id: "spectate-insights-panel", label: m.analyse_tab_insights(), open: insightsOpen, width: 384, closedWidth: 88, toggle: setInsightsOpen,
      content: <SpectateInsightsPanel pair={pair} controller={controller} /> },
    { id: "spectate-ai-panel", label: m.label_ai_analysis(), open: aiOpen, closedWidth: 112, toggle: onAiOpenChange,
      headerControls: <div ref={setAiHeaderControls} className="shrink-0 pr-3" />,
      content: <div className="h-full overflow-y-auto"><CompareAiPanel panelOpen headerTarget={aiHeaderControls}
        lapA={{ id: pair.comparison.lapA.id, label: `${m.compare_lap_label()} ${pair.comparison.lapA.lapNumber} (${formatLapTime(pair.comparison.lapA.lapTime)})`, lapTime: pair.comparison.lapA.lapTime }}
        lapB={{ id: pair.comparison.lapB.id, label: `${m.compare_lap_label()} ${pair.comparison.lapB.lapNumber} (${formatLapTime(pair.comparison.lapB.lapTime)})`, lapTime: pair.comparison.lapB.lapTime }}
        segments={segments.map(({ name, startFrac, endFrac }) => ({ name, startFrac, endFrac }))} /></div> },
  ]}>
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <SpectateScene pair={pair} controller={controller} outline={outline} focus={focus}
        overview={<SpectateOverview pair={pair} controller={controller} segments={segments} focus={focus} />} />
      <SpectateFocusToolbar focus={focus} onChange={setFocusMode} />
      <SpectateLineScore trace={lineSpread.data} pair={pair} controller={controller} />
      <SpectateInputs pair={pair} controller={controller} />
    </div>
    <SpectatePlayback controller={controller} pair={pair} />
  </SpectateWorkspace>
); }
