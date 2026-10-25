import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SingleReplaySession } from "@raceiq/lap-replay/ui";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapReference, ReplayOpponentMetadata, SpectateSegment } from "@raceiq/lap-replay/contracts";
import { useSessionLaps } from "@/hooks/laps";
import { useSessions } from "@/hooks/session-queries";
import { useOpponentLapCatalog, useOpponentLapSemanticTelemetry, OpponentQueryError } from "@/hooks/opponents";
import { useCarName } from "@/hooks/catalog-queries";
import { useTrackOutline, useTrackSectors } from "@/hooks/track-queries";
import { useGameId } from "@/stores/game";
import { OpponentLapSelector } from "@/components/comparison/ComparisonSelectors";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
export function OpponentLapReplay({ anchor, opponentLapId, sourceRevision }: { anchor: LapMeta | undefined; opponentLapId: string; sourceRevision: string }) {
  const navigate = useNavigate();
  const gameId = useGameId();
  const sessionsQuery = useSessions({ allGames: true });
  const savedSessions = (sessionsQuery.data ?? []).filter((session) => session.gameId === "lmu");
  const [targetSessionId, setTargetSessionId] = useState<number | null>(null);
  const targetLapsQuery = useSessionLaps(targetSessionId);
  const targetAnchor = targetLapsQuery.data?.filter((lap) => lap.processing.state === "ready").sort((a, b) => a.lapNumber - b.lapNumber)[0];
  const switching = targetSessionId != null && targetSessionId !== anchor?.sessionId;
  const activeAnchor = switching ? targetAnchor : anchor;
  const playerLapsQuery = useSessionLaps(activeAnchor?.sessionId ?? null);
  const playerCarName = useCarName(activeAnchor?.carId).data;
  const anchorReady = activeAnchor?.processing.state === "ready";
  const catalogQuery = useOpponentLapCatalog(gameId === "lmu" && anchorReady ? activeAnchor.id : null);
  const catalog = catalogQuery.data;
  const summary = catalog?.laps.find((lap) => lap.opponentLapId === opponentLapId);
  const reference: OpponentLapReference | null = gameId === "lmu" && anchorReady && !catalogQuery.isFetching && catalog?.indexState === "ready" &&
    catalog.sourceRevision === sourceRevision && summary?.mode === "telemetry"
    ? { kind: "opponent", playerLapId: activeAnchor!.id, opponentLapId, sourceRevision }
    : null;
  const replayQuery = useOpponentLapSemanticTelemetry(reference);
  const sectorTimes = summary?.sectors.every((sector) => sector.duration.state === "ok" && typeof sector.duration.value === "number")
    ? summary.sectors.map((sector) => sector.duration.state === "ok" ? sector.duration.value! : 0)
    : undefined;
  const metadata: ReplayOpponentMetadata | null = reference && summary && activeAnchor?.trackId ? {
    kind: "opponent",
    id: opponentLapId,
    reference,
    trackId: activeAnchor.trackId,
    lapNumber: summary.lapNumber,
    lapTime: summary.lapTime.state === "ok" && typeof summary.lapTime.value === "number" ? summary.lapTime.value : null,
    ...(sectorTimes ? { sectorTimes } : {}),
  } : null;
  const { data: outlineData } = useTrackOutline(activeAnchor?.trackId ?? undefined);
  const outline = Array.isArray(outlineData) ? outlineData : outlineData?.points ?? null;
  const { data: sectorData } = useTrackSectors(activeAnchor?.trackId ?? undefined);
  const segments = getSpectateSegments(sectorData);
  const trackLengthM = typeof sectorData === "object" && sectorData !== null && "totalDist" in sectorData &&
    typeof sectorData.totalDist === "number" && Number.isFinite(sectorData.totalDist) && sectorData.totalDist > 0 ? sectorData.totalDist : undefined;
  const error = catalogQuery.error ?? replayQuery.error;
  const selector = <OpponentLapSelector key={`${activeAnchor?.id ?? "none"}:${sourceRevision}:${opponentLapId}`} laps={catalog?.laps ?? []} sessions={catalog?.sessions ?? []} value={opponentLapId} selectImmediately
    playerLaps={playerLapsQuery.data ?? []} selectedPlayerLapId={activeAnchor?.id}
    playerCarName={playerCarName || activeAnchor?.carId}
    savedSessions={savedSessions} selectedSavedSessionId={targetSessionId ?? activeAnchor?.sessionId}
    onSavedSessionChange={setTargetSessionId}
    onChange={(id) => {
      if (!activeAnchor || !catalog) return;
      void navigate({ search: ((previous: Record<string, unknown>) => ({ ...previous, opponentLap: id ?? undefined, opponentRevision: id ? catalog.sourceRevision : undefined })) as never, replace: true, resetScroll: false });
    }}
    onPlayerLapChange={(id) => {
      if (!activeAnchor) return;
      void navigate({ to: `/lmu/sessions/${activeAnchor.sessionId}/replay/${id}` as never, search: {} as never, resetScroll: false });
    }} />;
  useEffect(() => {
    if (!switching || !activeAnchor || !catalog || catalogQuery.isFetching || catalog.indexState !== "ready") return;
    const playable = catalog.laps.find((lap) => lap.mode === "telemetry");
    if (!playable) return;
    void navigate({ to: `/lmu/sessions/${activeAnchor.sessionId}/replay/${activeAnchor.id}` as never,
      search: ((previous: Record<string, unknown>) => ({ ...previous, opponentLap: playable.opponentLapId, opponentRevision: catalog.sourceRevision })) as never,
      resetScroll: false });
    setTargetSessionId(null);
  }, [switching, activeAnchor, catalog, catalogQuery.isFetching, navigate]);
  if (gameId !== "lmu") return <>{selector}<State state="unavailable">{m.analyse_unavailable()}</State></>;
  if (switching && targetLapsQuery.error) return <>{selector}<State state="unavailable" refresh={() => { void targetLapsQuery.refetch(); }}>{m.analyse_unavailable()}</State></>;
  if (switching && (targetLapsQuery.isLoading || !targetLapsQuery.data)) return <>{selector}<State state="loading">{m.compare_loading()}</State></>;
  if (switching && !targetAnchor) return <>{selector}<State state="missing">{m.analyse_unavailable()}</State></>;
  if (!activeAnchor) return <>{selector}<State state="missing">{m.analyse_unavailable()}</State></>;
  if (!catalog && catalogQuery.isFetching) return <>{selector}<State state="loading">{m.compare_loading()}</State></>;
  if (error instanceof OpponentQueryError) {
    const state = error.code === "OPPONENT_DATA_REMOVED" ? "removed"
      : error.code === "SOURCE_CHANGED" ? "source-changed"
        : error.code === "OPPONENT_LAP_NOT_FOUND" ? "missing"
          : error.code === "OPPONENT_INDEX_FAILED" ? "failed" : "unavailable";
    return <>{selector}<State state={state} refresh={state === "failed" ? () => { void catalogQuery.refetch(); } : undefined}>{state === "removed" ? m.compare_opponent_removed() : state === "failed" ? m.compare_opponent_index_failed() : m.analyse_unavailable()}</State></>;
  }
  if (catalogQuery.error) return <>{selector}<State state="unavailable" refresh={() => { void catalogQuery.refetch(); }}>{m.sessions_opponents_unavailable()}</State></>;
  if (catalogQuery.isFetching) return <>{selector}<State state="loading">{m.sessions_opponents_loading()}</State></>;
  if (catalog?.opponentRetention === "removed") return <>{selector}<State state="removed">{m.compare_opponent_removed()}</State></>;
  if (catalog?.opponentRetention === "not-recorded") return <>{selector}<State state="not-recorded">{m.compare_opponent_not_recorded()}</State></>;
  if (catalog?.opponentAvailability === "missing" || catalog?.opponentAvailability === "corrupt") return <>{selector}<State state={catalog.opponentAvailability}>{catalog.opponentAvailability === "corrupt" ? m.storage_opponents_skip_invalid_source() : m.lmu_state_missing()}</State></>;
  if (catalog?.indexState === "failed") return <>{selector}<State state="failed" refresh={() => { void catalogQuery.refetch(); }}>{m.compare_opponent_index_failed()}</State></>;
  if (catalog?.indexState === "not-required") return <>{selector}<State state="not-required">{m.sessions_opponents_unavailable()}</State></>;
  if (catalog?.indexState !== "ready") return <>{selector}<State state={catalog?.indexState ?? "loading"}>{catalog?.indexState === "waiting-finalization" ? m.compare_opponent_index_waiting() : catalog?.indexState === "queued" ? m.compare_opponent_index_queued() : catalog?.indexState === "building" ? m.compare_opponent_index_building() : m.compare_loading()}</State></>;
  if (catalog.sourceRevision !== sourceRevision) return <>{selector}<State state="source-changed">{m.analyse_unavailable()}</State></>;
  if (!summary || summary.mode !== "telemetry") return <>{selector}<State state="missing">{m.analyse_unavailable()}</State></>;
  if (!metadata) return <>{selector}<State state="unavailable">{m.analyse_unavailable()}</State></>;
  if (replayQuery.isFetching && !replayQuery.data) return <>{selector}<State state="loading">{m.analyse_loading_telemetry()}</State></>;
  if (replayQuery.error) return <>{selector}<State state="unavailable" refresh={() => { void replayQuery.refetch(); }}>{m.analyse_unavailable()}</State></>;
  if (!replayQuery.data || replayQuery.data.envelopes.length === 0) return <>{selector}<State state="empty">{m.analyse_no_telemetry_data()}</State></>;
  return <section data-testid="opponent-lap-replay" data-opponent-state="ready" data-opponent-lap-id={opponentLapId} className="flex h-full min-h-0 flex-1 flex-col gap-2 p-3">
    <header className="flex flex-wrap items-center justify-start gap-3 border-b border-app-border pb-3 text-sm text-app-text-secondary">
      {selector}
    </header>
    <SingleReplaySession gameId="lmu" lap={metadata} replay={replayQuery.data} outline={outline} segments={segments} trackLengthM={trackLengthM} ai={() => null} aiOpen={false} onAiOpenChange={() => undefined} panelHeaderTarget={null} />
  </section>;
}

function State({ state, children, refresh }: { state: string; children: string; refresh?: () => void }) {
  return <div role={state === "failed" ? "alert" : "status"} data-opponent-state={state} className="flex flex-wrap items-center gap-2 p-4 text-app-text-secondary">
    <span>{children}</span>{refresh && <Button type="button" variant="app-outline" size="app-sm" onClick={refresh}>{m.recording_processing_refresh()}</Button>}
  </div>;
}
function getSpectateSegments(data: unknown): SpectateSegment[] {
  if (typeof data !== "object" || data === null || !("segments" in data) || !Array.isArray(data.segments)) return [];
  return data.segments.filter((segment): segment is SpectateSegment =>
    typeof segment === "object" && segment !== null &&
    "name" in segment && typeof segment.name === "string" &&
    "type" in segment && typeof segment.type === "string" &&
    "startFrac" in segment && typeof segment.startFrac === "number" && Number.isFinite(segment.startFrac) &&
    "endFrac" in segment && typeof segment.endFrac === "number" && Number.isFinite(segment.endFrac));
}
