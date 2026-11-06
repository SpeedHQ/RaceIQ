import type { TrackProjection } from "@raceiq/scene-3d/wireframe/ScenePlacement";
import { useCompareLineSpread } from "./host";
import { SpectateLineScore } from "./SpectateLineScore";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMessages } from "./host"
import { CompareAiPanel } from "./host"
import { useReplayHost } from "./host"
import { SpectateScene } from "./SpectateScene";
import { SpectateTelemetryPanel } from "./SpectateTelemetryPanel";
import { SpectateCarPanel } from "./SpectateCarPanel";
import { SpectateOverview } from "./SpectateOverview";
import { SpectateInputs } from "./SpectateInputs";
import { SpectatePlayback } from "./SpectatePlayback";
import type { ReplaySession, SpectateController, SpectateSegment } from "../contracts/spectate";
import type { TrackMapBoundaries } from "../contracts/host";
import { buildSpectateFocus, type SpectateFocusMode } from "./spectate-focus";
import { SpectateFocusToolbar } from "./SpectateFocusToolbar";
import { SpectateDataPanel } from "./SpectateDataPanel";
import { ReplaySegmentsPanel } from "./ReplaySegmentsPanel";
import { SpectateInsightsPanel } from "./SpectateInsightsPanel";
import { useLocalStorage } from "./host"
import { SpectateWorkspace } from "./SpectateWorkspace"
import { useSceneMode } from "./useSceneMode";

const FOCUS_MODES: readonly SpectateFocusMode[] = ["inputs", "speed", "balance", "ers"];
export function SpectateView({
  pair,
  controller,
  outline,
  trackProjection,
  segments,
  trackBoundaries,
  aiOpen,
  telemetryOpen,
  carPanelOpen,
  onTelemetryOpenChange,
  onCarPanelOpenChange,
  panelHeaderTarget,
  onAiOpenChange,
  ai,
}: {
  pair: ReplaySession;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
  trackProjection?: TrackProjection | null;
  segments: readonly SpectateSegment[];
  trackBoundaries?: TrackMapBoundaries | null;
  aiOpen: boolean;
  telemetryOpen: boolean;
  carPanelOpen: boolean;
  onTelemetryOpenChange: (open: boolean) => void;
  onCarPanelOpenChange: (open: boolean) => void;
  panelHeaderTarget: HTMLDivElement | null;
  onAiOpenChange: (open: boolean) => void;
  ai?: (headerTarget: HTMLDivElement | null) => ReactNode;
}) {
const { formatLapTime } = useReplayHost(); const m = useMessages(); const single = pair.b === null;
const playerLapA = pair.comparison.lapA && !("kind" in pair.comparison.lapA) ? pair.comparison.lapA : null;
const playerLapB = pair.comparison.lapB && !("kind" in pair.comparison.lapB) ? pair.comparison.lapB : null;
const opponentPair = pair.comparison.lapA !== null && "kind" in pair.comparison.lapA || pair.comparison.lapB !== null && "kind" in pair.comparison.lapB;
const opponentReplay = single && opponentPair;
const [focusMode, setFocusMode] = useSceneMode<SpectateFocusMode>("spectate-focus-mode", "inputs", FOCUS_MODES);
const focus = useMemo(() => buildSpectateFocus(pair, focusMode), [pair, focusMode]);
const [telemetryHeaderControls, setTelemetryHeaderControls] = useState<HTMLDivElement | null>(null);
const [aiHeaderControls, setAiHeaderControls] = useState<HTMLDivElement | null>(null);
const [dataOpen, setDataOpen] = useLocalStorage(single ? "replay-data-open" : "spectate-data-open", single);
const [insightsOpen, setInsightsOpen] = useLocalStorage(single ? "replay-insights-open" : "spectate-insights-open", false);
const [segmentsOpen, setSegmentsOpen] = useLocalStorage("replay-segments-open", false);
const view = useRef<HTMLDivElement>(null);
useLayoutEffect(() => {
  const root = view.current;
  const inputs = root?.querySelector<HTMLElement>("[data-spectate-inputs]");
  if (!root || !inputs) return;
  let height = -1;
  const measure = () => {
    const nextHeight = inputs.offsetHeight;
    if (nextHeight === height) return;
    height = nextHeight;
    root.style.setProperty("--spectate-inputs-height", `${height}px`);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(inputs);
  measure();
  return () => observer.disconnect();
}, []);
return (
  <SpectateWorkspace storageKey={single ? "replay-panel-width" : "spectate-panel-width"} panelHeaderTarget={panelHeaderTarget} panels={[
    { id: single ? "replay-telemetry-panel" : "spectate-telemetry-panel", label: m.spectate_telemetry(), open: telemetryOpen, closedWidth: 100, toggle: onTelemetryOpenChange, collapseOnNarrow: true,
      headerControls: <div ref={setTelemetryHeaderControls} className="shrink-0 pr-3" />,
      content: <SpectateTelemetryPanel pair={pair} controller={controller} headerTarget={telemetryHeaderControls} /> },
    ...(!opponentReplay ? [{ id: single ? "replay-car-panel" : "spectate-2d-panel", label: "Car layout", open: carPanelOpen, width: 384, closedWidth: 88, toggle: onCarPanelOpenChange,
      content: <SpectateCarPanel pair={pair} controller={controller} /> },
    { id: single ? "replay-data-panel" : "spectate-data-panel", label: m.analyse_tab_data(), open: dataOpen, width: 384, closedWidth: 72, toggle: setDataOpen,
      content: <div className="h-full overflow-y-auto"><SpectateDataPanel pair={pair} controller={controller} /></div> }] : []),
    ...(single ? [{ id: "replay-segments-panel", label: m.overlay_segments(), open: segmentsOpen, width: 288, closedWidth: 88, toggle: setSegmentsOpen,
      content: <ReplaySegmentsPanel lap={pair.a} controller={controller} segments={segments} /> }] : []),
    ...(!opponentPair ? [{ id: single ? "replay-insights-panel" : "spectate-insights-panel", label: m.analyse_tab_insights(), open: insightsOpen, width: 384, closedWidth: 88, toggle: setInsightsOpen,
      content: <SpectateInsightsPanel pair={pair} controller={controller} /> }] : []),
    ...(!opponentPair ? [{ id: single ? "replay-ai-panel" : "spectate-ai-panel", label: m.label_ai_analysis(), open: aiOpen, closedWidth: 112, toggle: onAiOpenChange,
      headerControls: <div ref={setAiHeaderControls} className="shrink-0 pr-3" />,
      content: <div className="h-full overflow-y-auto">{playerLapA && playerLapB && pair.b ? <CompareAiPanel panelOpen headerTarget={aiHeaderControls}
        lapA={{ id: playerLapA.id, label: `${m.compare_lap_label()} ${playerLapA.lapNumber} (${formatLapTime(playerLapA.lapTime)})`, lapTime: playerLapA.lapTime }}
        lapB={{ id: playerLapB.id, label: `${m.compare_lap_label()} ${playerLapB.lapNumber} (${formatLapTime(playerLapB.lapTime)})`, lapTime: playerLapB.lapTime }}
        segments={segments.map(({ name, startFrac, endFrac }) => ({ name, startFrac, endFrac }))} /> : ai?.(aiHeaderControls)}</div> }] : []),
  ]}>
    <div ref={view} className="relative flex min-h-0 flex-1 flex-col overflow-hidden max-sm:has-[[data-spectate-overview]]:min-h-[calc(var(--spectate-inputs-height,8rem)+40rem)]">
      <div className="relative min-h-0 flex-1 overflow-hidden">
      <SpectateScene pair={pair} controller={controller} outline={outline} trackProjection={trackProjection} trackBoundaries={trackBoundaries} focus={focus}
        overview={<SpectateOverview pair={pair} controller={controller} segments={segments} focus={focus} />} />
      <SpectateFocusToolbar focus={focus} onChange={setFocusMode} single={single} tirePanelOpen={!opponentReplay && carPanelOpen} onTirePanelOpenChange={opponentReplay ? undefined : onCarPanelOpenChange} />
      {pair.b && playerLapA && playerLapB && <ComparisonLineScore pair={pair} controller={controller} lapAId={playerLapA.id} lapBId={playerLapB.id} />}
      </div>
      <SpectateInputs pair={pair} controller={controller} />
    </div>
    <SpectatePlayback controller={controller} pair={pair} />
  </SpectateWorkspace>
); }
function ComparisonLineScore({ pair, controller, lapAId, lapBId }: { pair: ReplaySession; controller: SpectateController; lapAId: number; lapBId: number }) {
  const { data } = useCompareLineSpread(pair.gameId, [lapAId, lapBId]);
  return <SpectateLineScore trace={data} pair={pair} controller={controller} />;
}
