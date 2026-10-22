import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { routePrefixForGameId } from "../../lib/game-routes";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { F1CarSetup } from "@raceiq/shared/telemetry/f1-2025";
import type { AiPanelHandle } from "@/components/ai/AiPanel";
import { useCookieState } from "../../hooks/useCookieState";
import type { AnalyseSearch } from "@raceiq/session-analyse/contracts";
import { client } from "../../lib/rpc";
import { useRequiredGameId } from "../../stores/game";
import { queryKeys } from "../../hooks/query-keys";
import { AnalyseLapHeader } from "./AnalyseLapHeader";
import { AnalyseWorkspaceModals } from "./AnalyseWorkspaceModals";
import { SingleReplaySession } from "@raceiq/lap-replay/ui";
import type { SpectateController } from "@raceiq/lap-replay/contracts";
import { AnalyseAiSidebar } from "./AnalyseAiSidebar";
import { AnalyseWorkspaceStatus } from "./AnalyseWorkspaceStatus";
import { useAnalyseImports } from "./useAnalyseImports";
import { useAnalyseSelections } from "./useAnalyseSelections";
import { SessionIdentityDialog } from "../import/SessionIdentityDialog";
import { useCarsForGame, useTracksForGame } from "../../hooks/catalog-queries";
import { buildExportCsv } from "../../lib/lap-export";

// ── Main Component ───────────────────────────────────────────────────

export function LapAnalyse({ sessionId, initialLapId }: { sessionId?: number; initialLapId?: number } = {}) {
  return <LapAnalyseInner sessionId={sessionId} initialLapId={initialLapId} />;
}

function LapAnalyseInner({ sessionId, initialLapId }: { sessionId?: number; initialLapId?: number }) {
  const search = useSearch({ strict: false }) as AnalyseSearch;
  const gameId = useRequiredGameId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    setLaps,
    lapLoading,
    lapError,
    parseError,
    semanticFrames,
    selectedLap,
    semanticReplay,
    selectedTrack,
    selectedCar,
    selectedLapId,
    setSelectedLapId,
    outline,

    segments,
    initialCursor,
    trackNames,
    carNames,
    tracks,
    carsForTrack,
    filteredLaps,
    carName,
    trackName,
    handleTrackChange,
    handleCarChange,
  } = useAnalyseSelections(initialLapId == null ? search : { ...search, lap: initialLapId }, gameId, sessionId);
  const identitySessionId = sessionId ?? selectedLap?.sessionId;
  const { data: sessions = [] } = useQuery({
    queryKey: [...queryKeys.sessions, gameId],
    queryFn: async () => {
      const response = await client.api.sessions.$get({ query: { gameId } });
      if (!response.ok) throw new Error(`Failed to load sessions (${response.status})`);
      return response.json() as Promise<{ id: number; carId: string | null; trackId: string | null; gameId: string }[]>;
    },
    enabled: identitySessionId != null,
  });
  const identitySession = sessions.find((session) => session.id === identitySessionId);
  const { data: catalogCars, isError: carsCatalogError } = useCarsForGame(gameId);
  const { data: catalogTracks, isError: tracksCatalogError } = useTracksForGame(gameId);
  const carIds = new Set((catalogCars ?? []).map((car) => String(car.id)));
  const trackIds = new Set((catalogTracks ?? []).map((track) => String(track.id)));
  const catalogsLoaded = catalogCars !== undefined && catalogTracks !== undefined;
  const [repairDismissed, setRepairDismissed] = useState(false);
  useEffect(() => {
    setRepairDismissed(false);
  }, [identitySessionId]);
  const repairOpen = identitySession != null && !repairDismissed && (
    !identitySession.carId || !identitySession.trackId ||
    (catalogsLoaded && (!carIds.has(identitySession.carId) || !trackIds.has(identitySession.trackId))) ||
    carsCatalogError || tracksCatalogError
  );
  async function saveIdentity(identity: { carId: string; trackId: string }) {
    const response = await client.api.sessions[":id"].identity.$patch({
      param: { id: String(identitySessionId) },
      json: { gameId, ...identity },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Failed to save session identity (${response.status})`);
    }
    setRepairDismissed(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      queryClient.invalidateQueries({ queryKey: queryKeys.userTunes }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionResults }),
      queryClient.invalidateQueries({ queryKey: queryKeys.raceResultSummaries }),
      queryClient.invalidateQueries({ queryKey: queryKeys.raceResultRecents }),
    ]);
  }
  const loading = lapLoading;
  const [aiPanelOpen, setAiPanelOpen] = useCookieState("analyse-aiPanel", false);
  useEffect(() => {
    if (search.ai === 1) setAiPanelOpen(true);
  }, [search.ai, setAiPanelOpen]);
  const [setup, setSetup] = useState<F1CarSetup | null>(null);
  const aiPanelRef = useRef<AiPanelHandle>(null);
  const [viewingTuneId, setViewingTuneId] = useState<number | null>(null);
  const replayController = useRef<SpectateController | null>(null);
  const [panelHeaderTarget, setPanelHeaderTarget] = useState<HTMLDivElement | null>(null);
  const handleController = useCallback((controller: SpectateController | null) => {
    replayController.current = controller;
  }, []);

  // Tune selector
  const { data: availableTunes } = useQuery({
    queryKey: ["tunes", gameId, selectedLap?.carId],
    queryFn: () => client.api.tunes.$get({ query: { gameId, carId: selectedLap?.carId ?? undefined } }).then((r) => r.json() as any),
    enabled: gameId !== "lmu" && selectedLap?.carId != null,
  });
  const { data: persistedF1Setup } = useQuery<{ setup: F1CarSetup | null }>({
    queryKey: ["lap-setup", gameId, selectedLapId],
    queryFn: async () => {
      const response = await fetch(`/api/laps/${selectedLapId}/setup`, { headers: { "X-Game-Id": gameId } });
      if (!response.ok) throw new Error("Failed to load lap setup");
      return response.json() as Promise<{ setup: F1CarSetup | null }>;
    },
    enabled: gameId === "f1-2025" && selectedLapId != null,
  });

  const updateLapTune = useMutation({
    mutationFn: (tuneId: number | null) => client.api.laps[":id"].tune.$patch({ param: { id: String(selectedLapId) }, json: { tuneId } }).then((r) => r.json() as any),
    onMutate: (tuneId) => {
      // Optimistically update local laps state so dropdown doesn't reset
      setLaps((prev) =>
        prev.map((l) => (l.id === selectedLapId ? { ...l, tuneId: tuneId ?? undefined, tuneName: availableTunes?.find((t: { id: number; name: string }) => t.id === tuneId)?.name } : l)),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.userTunes });
    },
  });

  const updateLapNotesMutation = useMutation({
    mutationFn: (notes: string) => client.api.laps[":id"].notes.$patch({ param: { id: String(selectedLapId) }, json: { notes: notes || null } }).then((r) => r.json() as any),
    onMutate: (notes) => {
      setLaps((prev) => prev.map((l) => (l.id === selectedLapId ? { ...l, notes: notes || undefined } : l)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["laps"] });
    },
  });

  const deleteLapMutation = useMutation({
    mutationFn: (lapId: number) => client.api.laps[":id"].$delete({ param: { id: String(lapId) } }).then((r) => r.json() as any),
    onSuccess: () => {
      setSelectedLapId(null);
      queryClient.invalidateQueries({ queryKey: ["laps"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.userTunes });
      if (sessionId != null) {
        const routePrefix = routePrefixForGameId(gameId);
        if (routePrefix) void navigate({ to: `/${routePrefix}/sessions` as never, replace: true });
      }
    },
  });
  const handleDeleteLap = useCallback(() => {
    if (!selectedLapId) return;
    const lap = filteredLaps.find((candidate) => candidate.id === selectedLapId);
    const label = lap ? `Lap ${lap.lapNumber}` : `Lap ${selectedLapId}`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    deleteLapMutation.mutate(selectedLapId);
  }, [selectedLapId, filteredLaps, deleteLapMutation.mutate]);
  const handleTuneChange = useCallback((tuneId: number | null) => updateLapTune.mutate(tuneId), [updateLapTune.mutate]);
  const handleNotesChange = useCallback((notes: string) => updateLapNotesMutation.mutate(notes), [updateLapNotesMutation.mutate]);
  const f1Setup = useMemo<F1CarSetup | null>(() => {
    if (gameId !== "f1-2025") return null;
    if (persistedF1Setup?.setup) return persistedF1Setup.setup;
    if (!selectedLap?.carSetup) return null;
    try {
      return JSON.parse(selectedLap.carSetup) as F1CarSetup;
    } catch {
      return null;
    }
  }, [gameId, persistedF1Setup?.setup, selectedLap?.carSetup]);
  const hasF1Setup = f1Setup != null;
  const handleShowSetup = useCallback(() => {
    if (f1Setup) setSetup(f1Setup);
  }, [f1Setup]);
  const { exportingBin, importingBin, ownership, setOwnership, importResult, ibtPreview, handleExportBin, handleImportBin, handleCancelIbt, handleCommitIbt, setImportResult } = useAnalyseImports({
    queryClient,
  });

  const handleBackToSessions = useCallback(() => {
    const routePrefix = routePrefixForGameId(gameId);
    if (routePrefix) void navigate({ to: `/${routePrefix}/sessions` as never });
  }, [gameId, navigate]);
  const analyseSessionId = sessionId ?? selectedLap?.sessionId;
  const handleAnalyseSession = useCallback(() => {
    const routePrefix = routePrefixForGameId(gameId);
    if (routePrefix && analyseSessionId != null) void navigate({ to: `/${routePrefix}/sessions/${analyseSessionId}/analyse` as never });
  }, [analyseSessionId, gameId, navigate]);
  return (
    <div data-testid="lap-analyse-workspace" className="flex min-h-full min-w-0 flex-col @5xl/workspace:h-full @5xl/workspace:min-h-0 @5xl/workspace:overflow-hidden">
      {/* Header: cascading selectors + export */}
      <AnalyseLapHeader
        gameId={gameId}
        onBack={handleBackToSessions}
        sessionFocused={sessionId != null}
        onAnalyseSession={analyseSessionId != null ? handleAnalyseSession : undefined}
        panelHeaderRef={setPanelHeaderTarget}
        onExport={() =>
          buildExportCsv(
            semanticFrames.map((frame) => frame.values),
            carName,
            trackName,
            selectedLap,
            selectedLapId,
          )
        }
        onExportBin={() => handleExportBin(selectedLapId)}
        selectedTrack={selectedTrack}
        selectedCar={selectedCar}
        selectedLapId={selectedLapId}
        selectedLap={selectedLap}
        hasF1Setup={hasF1Setup}
        trackNames={trackNames}
        carNames={carNames}
        tracks={tracks}
        carsForTrack={carsForTrack}
        filteredLaps={filteredLaps}
        hasTelemetry={semanticFrames.length > 0}
        availableTunes={availableTunes}
        tunePending={updateLapTune.isPending}
        loading={loading}
        onTrackChange={handleTrackChange}
        onCarChange={handleCarChange}
        onLapChange={setSelectedLapId}
        onTuneChange={handleTuneChange}
        onViewTune={setViewingTuneId}
        onShowSetup={handleShowSetup}
        onImportBin={handleImportBin}
        exportingBin={exportingBin}
        importingBin={importingBin}
        ownership={ownership}
        onOwnershipChange={setOwnership}
        onDeleteLap={handleDeleteLap}
        onNotesChange={handleNotesChange}
      />

      {semanticFrames.length === 0 && <AnalyseWorkspaceStatus loading={loading} lapError={lapError} parseError={parseError} selectedLapId={selectedLapId} />}

      {semanticReplay && selectedLap && semanticFrames.length > 0 && (
        <SingleReplaySession
          key={selectedLap.id}
          gameId={gameId}
          lap={selectedLap}
          replay={semanticReplay}
          outline={outline}
          segments={segments ?? []}
          initialFrame={initialCursor}
          onController={handleController}
          panelHeaderTarget={panelHeaderTarget}
          aiOpen={aiPanelOpen}
          onAiOpenChange={setAiPanelOpen}
          ai={(headerTarget) => aiPanelOpen && selectedLapId ? (
            <AnalyseAiSidebar
              headerTarget={headerTarget}
              lapId={selectedLapId}
              trackName={trackName}
              carName={carName}
              segments={segments}
              aiPanelRef={aiPanelRef}
              onJumpToFrac={(frac) => {
                replayController.current?.seekFrame("a", Math.round(frac * (semanticReplay.envelopes.length - 1)));
              }}
            />
          ) : null}
        />
      )}
      <AnalyseWorkspaceModals
        viewingTuneId={viewingTuneId}
        onCloseTune={() => setViewingTuneId(null)}
        ibtPreview={ibtPreview}
        setup={setup}
        onCloseSetup={() => setSetup(null)}
        importingBin={importingBin}
        ownership={ownership}
        onOwnershipChange={setOwnership}
        onCommitIbt={() => void handleCommitIbt()}
        onCancelIbt={handleCancelIbt}
        importResult={importResult}
        gameId={gameId}
        onCloseImport={() => setImportResult(null)}
      />
      {repairOpen && identitySession && (
        <SessionIdentityDialog
          gameId={gameId}
          initialCarId={identitySession.carId}
          initialTrackId={identitySession.trackId}
          onSave={saveIdentity}
          onClose={() => setRepairDismissed(true)}
        />
      )}
    </div>
  );
}
