import { useEffect, useMemo, useRef, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { OpponentLapReference, OpponentLapSummary } from "../contracts/opponents";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { useReplayHost } from "./host";
import { useLapSemanticTelemetry } from "./host"
import { useSettings } from "./host"
import { createSpectateController, placeIRacingSpectateLaps, prepareSpectateLap } from "./spectate-replay";
import { useMessages } from "./host"
import { Button } from "./host"
import { LoadingIndicator } from "./host"
import { SpectateView } from "./SpectateView";
import type { SpectateController, ReplaySession, SpectateLap, SpectateSegment } from "../contracts/spectate";

type OpponentReplayComparison = {
  kind: "opponent";
  playerLap: LapMeta;
  opponent: OpponentLapSummary;
  reference: Extract<OpponentLapReference, { kind: "opponent" }>;
};
type ReplayPair = ReplaySession & { b: SpectateLap };

/** Kept above the conditional body: tabs preserve location, but never autoplay. */
export function SpectateSession({
  gameId,
  comparison,
  active,
  outline,
  segments,
  distanceRef,
  onDistanceChange,
  cursor,
  aiOpen,
  telemetryOpen,
  carPanelOpen,
  onTelemetryOpenChange,
  onCarPanelOpenChange,
  panelHeaderTarget,
  onAiOpenChange,
  onOpponentStatusRefresh,
}: {
  gameId: GameId;
  comparison: ComparisonData | OpponentReplayComparison;
  active: boolean;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
  distanceRef: { current: number | null };
  onDistanceChange: (distance: number | null) => void;
  cursor?: number;
  aiOpen: boolean;
  telemetryOpen: boolean;
  carPanelOpen: boolean;
  onTelemetryOpenChange: (open: boolean) => void;
  onCarPanelOpenChange: (open: boolean) => void;
  panelHeaderTarget: HTMLDivElement | null;
  onAiOpenChange: (open: boolean) => void;
  onOpponentStatusRefresh?: () => void;
}) { const m = useMessages(); const { displaySettings } = useSettings();
const fpsCap = useRef(displaySettings.renderFpsCap);
fpsCap.current = displaySettings.renderFpsCap;
const [requested, setRequested] = useState(active);
useEffect(() => {
  if (active) setRequested(true);
}, [active]);
const playerComparison = "lapA" in comparison ? comparison : null;
const opponentComparison = "kind" in comparison ? comparison : null;
const playerLap = playerComparison ? playerComparison.lapA : opponentComparison!.playerLap;
const replayHost = useReplayHost();
const replayAllowed = requested && playerLap.processing.state === "ready"
  && (!playerComparison || playerComparison.lapB.processing.state === "ready");
const replayA = useLapSemanticTelemetry(replayAllowed ? playerLap.id : null);
const replayB = useLapSemanticTelemetry(replayAllowed && playerComparison ? playerComparison.lapB.id : null);
const replayOpponent = replayHost.useOpponentLapSemanticTelemetry(replayAllowed && opponentComparison ? opponentComparison.reference : null);
const pair = useMemo<ReplayPair | null>(() => {
  if (playerLap.processing.state !== "ready" || (playerComparison && playerComparison.lapB.processing.state !== "ready")) return null;
  if (!replayA.data || replayA.data.lapId !== playerLap.id) return null;
  if (playerComparison) {
    const other = replayB.data;
    if (!other || other.lapId !== playerComparison.lapB.id) return null;
    return {
      gameId, comparison: playerComparison,
      a: prepareSpectateLap(replayA.data, playerComparison, "a"),
      b: prepareSpectateLap(other, playerComparison, "b"),
    };
  }
  const selected = opponentComparison!;
  const other = replayOpponent.data;
  if (!other || other.opponentLapId !== selected.reference.opponentLapId || other.sourceRevision !== selected.reference.sourceRevision) return null;
  const sectors = selected.opponent.sectors;
  return {
    gameId,
    comparison: { lapA: selected.playerLap, lapB: {
      kind: "opponent", id: selected.opponent.opponentLapId, reference: selected.reference,
      trackId: selected.playerLap.trackId, lapNumber: selected.opponent.lapNumber,
      lapTime: selected.opponent.lapTime.state === "ok" ? selected.opponent.lapTime.value : null,
      ...(sectors.length && sectors.every((sector) => sector.duration.state === "ok" && sector.duration.value !== null)
        ? { sectorTimes: sectors.map((sector) => sector.duration.value!) } : {}),
    } },
    a: prepareSpectateLap(replayA.data, undefined, "a", { preserveLapDistance: true }),
    b: prepareSpectateLap(other, undefined, "b", { preserveLapDistance: true }),
  };
}, [gameId, playerLap, playerComparison, opponentComparison, replayA.data, replayB.data, replayOpponent.data]);
const [controllerEntry, setControllerEntry] = useState<{ pair: ReplayPair; controller: SpectateController } | null>(null);
const controller = controllerEntry?.pair === pair ? controllerEntry.controller : null;
const distanceCallback = useRef(onDistanceChange);
distanceCallback.current = onDistanceChange;
useEffect(() => {
  if (!pair) return;
  const next = createSpectateController(pair.a, pair.b, distanceRef.current ?? undefined, () => fpsCap.current);
  setControllerEntry({ pair, controller: next });
  return () => {
    next.dispose();
  };
}, [pair, distanceRef]);
useEffect(() => {
  if (!controller) return;
  if (active) {
    if (distanceRef.current != null) controller.seekDistance(distanceRef.current, true);
    controller.setActive(true);
  } else {
    controller.setActive(false);
    distanceCallback.current(controller.getSnapshot().a?.distance ?? null);
  }
  return () => controller.setActive(false);
}, [active, controller, distanceRef]);
useEffect(() => {
  if (!active || !controller) return;
  const handleSpace = (event: KeyboardEvent) => {
    if ((event.code !== "Space" && event.key !== " ") || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest('textarea, select, [role="textbox"], [role="dialog"], [role="alertdialog"]')) return;
      if (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset"].includes(target.type)) return;
    }
    // Capture both phases of native Space activation before focused controls
    // can click, seek, or scroll instead of controlling replay.
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "keydown" && !event.repeat) {
      if (controller.getSnapshot().playing) controller.pause();
      else controller.play();
    }
  };
  window.addEventListener("keydown", handleSpace, true);
  window.addEventListener("keyup", handleSpace, true);
  return () => {
    window.removeEventListener("keydown", handleSpace, true);
    window.removeEventListener("keyup", handleSpace, true);
  };
}, [active, controller]);
const appliedCursor = useRef<number | undefined>(undefined);
useEffect(() => {
  if (cursor == null) {
    appliedCursor.current = undefined;
    return;
  }
  if (!controller || !active || !playerComparison || appliedCursor.current === cursor) return;
  const distances = playerComparison.traces.distance;
  const distance = distances[Math.max(0, Math.min(distances.length - 1, Math.floor(cursor)))];
  if (distance == null) return;
  controller.seekDistance(distance, true);
  appliedCursor.current = cursor;
}, [cursor, controller, playerComparison, active]);
if (!active) return null;
const blockedLap = playerLap.processing.state !== "ready" ? playerLap
  : playerComparison && playerComparison.lapB.processing.state !== "ready" ? playerComparison.lapB : null;
if (blockedLap) {
  const pending = blockedLap.processing.state === "queued" || blockedLap.processing.state === "processing";
  const message = blockedLap.processing.state === "queued" ? m.recording_processing_queued()
    : blockedLap.processing.state === "processing" ? m.recording_processing_running()
      : blockedLap.processing.error
        ? m.recording_processing_failed({ error: blockedLap.processing.error })
        : null;
  return <div role={pending ? "status" : "alert"} aria-busy={pending || undefined} data-processing-state={blockedLap.processing.state} className="flex flex-1 items-center justify-center text-app-detail text-app-text-secondary">{message}</div>;
}
const error = opponentComparison ? replayOpponent.error ?? replayA.error : replayA.error ?? replayB.error;
const errorCode = error && "code" in error ? error.code : null;
if (error && opponentComparison && errorCode === "OPPONENT_INDEX_NOT_READY")
  return <div role="status" data-opponent-state="not-ready" className="flex flex-1 items-center justify-center"><LoadingIndicator label={m.compare_loading()} /></div>;
if (error && opponentComparison && errorCode === "OPPONENT_INDEX_FAILED")
  return <div role="alert" data-opponent-state="failed" className="flex flex-1 flex-col items-center justify-center gap-3 text-app-detail text-status-danger">
    <p>{m.compare_opponent_index_failed()}</p>
    <p>{error.message}</p>
    <Button variant="app-outline" disabled={!onOpponentStatusRefresh} onClick={() => onOpponentStatusRefresh?.()}>{m.recording_processing_refresh()}</Button>
  </div>;
if (error)
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-app-detail text-status-danger">
      <p>{m.spectate_replay_failed()}</p>
      <p>{error.message}</p>
      <Button
        variant="app-outline"
        onClick={() => {
          void replayA.refetch();
          if (opponentComparison) void replayOpponent.refetch();
          else void replayB.refetch();
        }}
      >
        {m.spectate_retry()}
      </Button>
    </div>
  );
if (!pair || !controller)
  return (
    <div className="flex flex-1 items-center justify-center">
      <LoadingIndicator label={m.compare_loading()} />
    </div>
  );
if (pair.a.samples.length < 2 || pair.b.samples.length < 2)
  return (
    <div role="alert" className="flex flex-1 items-center justify-center text-app-detail text-status-unavailable">
      {m.spectate_replay_unavailable()}
    </div>
  );
return <SpectateView pair={pair} controller={controller} outline={outline} segments={segments} aiOpen={aiOpen} telemetryOpen={telemetryOpen} carPanelOpen={carPanelOpen} onTelemetryOpenChange={onTelemetryOpenChange} onCarPanelOpenChange={onCarPanelOpenChange} onAiOpenChange={onAiOpenChange} panelHeaderTarget={panelHeaderTarget} />; }
