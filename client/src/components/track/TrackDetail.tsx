import { segmentDisplayNames } from "@shared/racing/tracks/segment-label";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccTrackGuide, AccTrackSetups } from "@/components/acc/AccTrackSetups";
import { F125Leaderboard } from "@/components/f1/F125Leaderboard";
import { F125TrackGuide } from "@/components/f1/f125/TrackGuide";
import { F125SetupsWithGuide } from "@/components/f1/f125/TrackSetups";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBulkDeleteLaps } from "@/hooks/laps";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import { storedLapsSectorCount } from "@/lib/lap-sectors";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import { CatalogTrackSetups } from "./CatalogTrackSetups";
import { CommunityLeaderboard } from "./CommunityLeaderboard";
import { TrackDebugPanel } from "./debug/TrackDebugPanel";
import { LapManagement } from "./detail/LapManagement";
import { TrackCanvasPanel } from "./detail/TrackCanvasPanel";
import { TrackDebugSidebar } from "./detail/TrackDebugSidebar";
import type { TrackLap } from "./detail/types";
import { useTrackSegmentEditor } from "./detail/useTrackSegmentEditor";
import { TrackInfoPanel } from "./TrackInfoPanel";
import type { Point, TrackInfo, TrackSectors, TrackSegment } from "./types";

/**
 * TrackDetail — Full-size track view with segment overlay and stats sidebar.
 * Fetches both outline and sector data; segments are color-coded (red=corner, blue=straight).
 */
export function TrackDetail({
  track,
  onBack,
  tab,
  onTabChange,
}: {
  track: TrackInfo;
  onBack: () => void;
  /** The active tab, from the route. This component doesn't own it. */
  tab: string;
  /** Navigate to another tab's route. */
  onTabChange: (tab: string) => void;
}) {
  const gameId = useGameId();
  const gid = gameId ?? undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [pitRoad, setPitRoad] = useState<Point[][]>([]);
  const [flipX, setFlipX] = useState(false);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);
  const [segSource, setSegSource] = useState<string>(""); // "user" | "extracted" | "named" | "shared" | "auto"

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, z: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, z: 0 });
  zoomRef.current = zoom;
  panRef.current = pan;
  const dragging = useRef<{ startX: number; startY: number; startPanX: number; startPanZ: number } | null>(null);
  const [mapDisplayMode, setMapDisplayMode] = useState<"segments" | "sectors">("segments");
  const [editing, setEditing] = useState(false);
  const [editSegments, setEditSegments] = useState<TrackSegment[]>([]);
  const [saving, setSaving] = useState(false);
  const [sectorBounds, setSectorBounds] = useState<{ s1End: number; s2End: number } | null>(null);
  const [editingSectors, setEditingSectors] = useState(false);
  const [editS1, setEditS1] = useState(33.3);
  const [editS2, setEditS2] = useState(66.6);
  const [savingSectors, setSavingSectors] = useState(false);
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [selectedCars, setSelectedCars] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"time" | "lap" | "date">("time");
  const [sortAsc, setSortAsc] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isF125 = gameId === "f1-2025";
  const isAcc = gameId === "acc";
  const isAcEvo = gameId === "ac-evo";
  const hideClassCol = isF125 || isAcc || isAcEvo;

  const hasForzaTunes = gameId === "fm-2023";
  // Forza + AC-EVO share the catalog-driven master-detail setups panel.
  const hasCatalogSetups = hasForzaTunes || isAcEvo;
  const { startEditing, updateSegFrac, toggleSegType, addSegment, removeSegment, saveSegments, startEditingSectors, saveSectorBounds } = useTrackSegmentEditor({
    trackOrdinal: track.ordinal,
    gameId: gid,
    sectors,
    setSectors,
    sectorBounds,
    setSectorBounds,
    editSegments,
    setEditSegments,
    setEditing,
    setSaving,
    editS1,
    editS2,
    setEditS1,
    setEditS2,
    setEditingSectors,
    setSavingSectors,
  });
  // "info" leads: reference data and index route for unfamiliar tracks.
  const allTabs = hasCatalogSetups
    ? (["info", "laps", "setups", "debug"] as const)
    : isF125
      ? (["info", "laps", "setups", "guide", "debug"] as const)
      : isAcc
        ? (["info", "laps", "setups", "guide", "debug"] as const)
        : (["info", "laps", "debug"] as const);
  type Tab = (typeof allTabs)[number];
  const validTabs = allTabs;
  // The tab is the route — the URL owns it, not this component. A tab the
  // current game doesn't have falls back to info rather than rendering blank.
  const activeTab: Tab = (validTabs as readonly string[]).includes(tab) ? (tab as Tab) : "info";

  const { data: trackMapData } = useQuery({
    queryKey: ["track-map", track.ordinal, gameId ?? null],
    queryFn: () =>
      Promise.all([
        client.api["track-outline"][":ordinal"]
          .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid ?? undefined } })
          .then((r) => r.json() as unknown as { points?: Point[]; pitRoad?: Point[][]; flipX?: boolean } | Point[]),
        client.api["track-sectors"][":ordinal"]
          .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } })
          .then((r) => r.json() as unknown as (TrackSectors & { source?: string }) | null),
        client.api["track-sector-boundaries"][":ordinal"]
          .$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } })
          .then((r) => r.json() as unknown as { s1End: number; s2End: number } | null),
      ]).then(([outlineData, sectorData, boundsData]) => ({ outlineData, sectorData, boundsData })),
    enabled: track.hasOutline && !!gameId,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!trackMapData) return;
    const { outlineData, sectorData, boundsData } = trackMapData;
    if (!Array.isArray(outlineData) && outlineData?.points && Array.isArray(outlineData.points)) {
      setOutline(outlineData.points);
      setPitRoad(Array.isArray(outlineData.pitRoad) ? outlineData.pitRoad : []);
      setFlipX(outlineData.flipX ?? false);
    } else if (Array.isArray(outlineData)) {
      setOutline(outlineData as Point[]);
      setPitRoad([]);
    } else {
      setOutline(null);
      setPitRoad([]);
    }
    setSectors(sectorData);
    setSegSource((sectorData as (TrackSectors & { source?: string }) | null)?.source ?? "");
    if (boundsData?.s1End) setSectorBounds(boundsData);
  }, [trackMapData]);

  // Fetch all laps for this track
  const { data: trackLapsData = [], refetch: refetchLaps } = useQuery<TrackLap[]>({
    queryKey: ["track-laps", track.ordinal, gameId ?? null],
    queryFn: () =>
      client.api.tracks[":trackOrdinal"]["all-laps"]
        .$get({ param: { trackOrdinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } } as never)
        .then((r) => r.json() as unknown as TrackLap[] | null)
        .then((data) => data ?? []),
    staleTime: 30 * 1000,
  });

  const trackLaps = trackLapsData;

  // Use edit segments for preview when editing, otherwise use fetched sectors
  const displaySectors = editing && editSegments.length > 0 ? { segments: editSegments, totalDist: sectors?.totalDist ?? 0 } : sectors;

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    const showSectors = editingSectors || mapDisplayMode === "sectors";
    const sectorBoundsForDraw = editingSectors ? { starts: [0, editS1 / 100, editS2 / 100] } : sectorBounds ? { starts: [0, sectorBounds.s1End, sectorBounds.s2End] } : undefined;
    const sectorOverride = showSectors ? sectorBoundsForDraw : undefined;
    // While editing, every turn of a complex gets its own label so the row
    // being edited is identifiable on the map; otherwise the complex is
    // labelled once under its group name.
    drawTrack(canvasRef.current, outline, true, showSectors ? null : displaySectors, zoom, pan, sectorOverride, flipX, undefined, pitRoad, editing);
  }, [outline, pitRoad, displaySectors, zoom, pan, editingSectors, editS1, editS2, mapDisplayMode, sectorBounds, activeTab, flipX, editing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const factor = 0.999 ** e.deltaY;
      const newZoom = Math.min(Math.max(currentZoom * factor, 0.5), 4);
      if (Math.abs(newZoom - currentZoom) < 0.001) return;

      if (newZoom <= 0.51) {
        setZoom(1);
        setPan({ x: 0, z: 0 });
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = newZoom / currentZoom;
      setZoom(newZoom);
      setPan({
        x: mouseX - cx - (mouseX - cx - currentPan.x) * ratio,
        z: mouseY - cy - (mouseY - cy - currentPan.z) * ratio,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Corner names carry their official turn numbers; straights are auto-numbered.
  const segDisplayNames = useMemo(() => segmentDisplayNames(editing ? editSegments : (displaySectors?.segments ?? [])), [editing, editSegments, displaySectors]);

  const corners = displaySectors?.segments.filter((s) => s.type === "corner") ?? [];
  const straights = displaySectors?.segments.filter((s) => s.type === "straight") ?? [];

  // Lap manager: unique cars, filtered & sorted laps
  const uniqueCars = useMemo(() => {
    const map = new Map<number, { carOrdinal: number; carName: string; carClass: string }>();
    for (const l of trackLaps) {
      if (!map.has(l.carOrdinal)) map.set(l.carOrdinal, { carOrdinal: l.carOrdinal, carName: l.carName, carClass: l.carClass });
    }
    return Array.from(map.values()).sort((a, b) => a.carName.localeCompare(b.carName));
  }, [trackLaps]);

  const uniqueDivisions = useMemo(() => {
    const divs = new Set(trackLaps.map((l) => l.division).filter((d): d is string => !!d));
    return [...divs].sort();
  }, [trackLaps]);

  const filteredLaps = useMemo(() => {
    return trackLaps
      .filter((l) => selectedCars.size === 0 || selectedCars.has(l.carOrdinal))
      .filter((l) => !selectedDivision || l.division === selectedDivision)
      .sort((a, b) => {
        const cmp = sortBy === "time" ? a.lapTime - b.lapTime : sortBy === "date" ? new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime() : a.lapNumber - b.lapNumber;
        return sortAsc ? cmp : -cmp;
      });
  }, [trackLaps, selectedCars, selectedDivision, sortBy, sortAsc]);
  const sectorCount = storedLapsSectorCount(filteredLaps);

  const sessionLapCounts = useMemo(() => {
    if (!isF125) return new Map<number, number>();
    const counts = new Map<number, number>();
    for (const l of trackLaps) {
      if (l.sessionId != null) counts.set(l.sessionId, (counts.get(l.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [isF125, trackLaps]);
  const hasSessionTypes = useMemo(() => {
    if (!isF125) return false;
    const vals = [...sessionLapCounts.values()];
    return vals.some((c) => c > 1) && vals.some((c) => c === 1);
  }, [isF125, sessionLapCounts]);

  const toggleCar = useCallback((ord: number) => {
    setSelectedCars((prev) => {
      const next = new Set(prev);
      if (next.has(ord)) next.delete(ord);
      else next.add(ord);
      return next;
    });
    setSelectedLaps(new Set());
  }, []);

  const toggleLapSelect = useCallback((lapId: number) => {
    setSelectedLaps((prev) => {
      const next = new Set(prev);
      if (next.has(lapId)) next.delete(lapId);
      else next.add(lapId);
      return next;
    });
  }, []);

  const toggleAllLaps = useCallback(() => {
    if (selectedLaps.size === filteredLaps.length) setSelectedLaps(new Set());
    else setSelectedLaps(new Set(filteredLaps.map((l) => l.lapId)));
  }, [selectedLaps.size, filteredLaps]);

  const bulkDelete = useBulkDeleteLaps();
  const handleBulkDelete = useCallback(async () => {
    if (selectedLaps.size === 0) return;
    setDeleting(true);
    try {
      await bulkDelete.mutateAsync(Array.from(selectedLaps));
      setSelectedLaps(new Set());
      setConfirmDelete(false);
      void refetchLaps();
    } catch {}
    setDeleting(false);
  }, [selectedLaps, refetchLaps, bulkDelete]);

  const handleSort = useCallback(
    (col: "time" | "lap" | "date") => {
      if (sortBy === col) setSortAsc((a) => !a);
      else {
        setSortBy(col);
        setSortAsc(true);
      }
    },
    [sortBy],
  );

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 @3xl/workspace:flex-row @3xl/workspace:items-center">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            type="button"
            variant="app-ghost"
            size="app-sm"
            onClick={onBack}
            className="shrink-0 text-app-label text-app-text-secondary hover:text-app-text rounded bg-app-surface-alt hover:bg-app-surface-hover transition-colors"
          >
            &larr; {m.common_back()}
          </Button>
          <div className="min-w-0">
            <div className="text-app-heading font-semibold text-app-text">{track.name}</div>
            <div className="text-app-label text-app-text-muted">
              {track.variant} · {track.location}, {countryName(track.country)}
              {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
            </div>
          </div>
        </div>
        {/* View mode tabs */}
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList>
            {validTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {tab === "laps" && trackLaps.length > 0
                  ? `${m.label_laps()} (${trackLaps.length})`
                  : tab === "info"
                    ? m.track_detail_info_tab()
                    : tab === "guide"
                      ? m.track_detail_guides_tab()
                      : tab === "setups"
                        ? m.track_detail_setup_tab()
                        : tab === "debug"
                          ? m.trackdetail_debug_tab()
                          : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Debug: full-page view with segments/sectors sidebar */}
      {activeTab === "debug" ? (
        <div className="flex gap-4 h-[calc(100vh-160px)]">
          <div className="flex-1 min-h-0 overflow-hidden">
            <TrackDebugPanel
              trackOrdinal={track.ordinal}
              outline={outline}
              flipX={flipX}
              displaySectors={displaySectors}
              sectorBounds={editingSectors ? { s1End: editS1 / 100, s2End: editS2 / 100 } : sectorBounds}
              editingSegments={editing}
              editingSectors={editingSectors}
              trackLengthKm={track.lengthKm}
              trackCreatedAt={track.createdAt ?? undefined}
              corners={corners.length}
              straights={straights.length}
            />
          </div>
          <TrackDebugSidebar
            track={track}
            gameId={gameId}
            displaySectors={displaySectors}
            segSource={segSource}
            editing={editing}
            editSegments={editSegments}
            saving={saving}
            sectorBounds={sectorBounds}
            editingSectors={editingSectors}
            editS1={editS1}
            editS2={editS2}
            savingSectors={savingSectors}
            segDisplayNames={segDisplayNames}
            startEditing={startEditing}
            saveSegments={saveSegments}
            toggleSegType={toggleSegType}
            addSegment={addSegment}
            removeSegment={removeSegment}
            updateSegFrac={updateSegFrac}
            setEditing={setEditing}
            startEditingSectors={startEditingSectors}
            saveSectorBounds={saveSectorBounds}
            setEditingSectors={setEditingSectors}
            setEditS1={setEditS1}
            setEditS2={setEditS2}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4 @5xl/workspace:h-[calc(100vh-160px)] @5xl/workspace:overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col gap-4 @3xl/workspace:overflow-hidden">
            {/* Track map — hidden on setups tab so the setups panel can take the full left column */}
            {activeTab !== "setups" && (
              <div className={`flex shrink-0 flex-col gap-3 @3xl/workspace:flex-row ${activeTab === "guide" && isF125 ? "@3xl/workspace:h-[160px]" : "@3xl/workspace:h-[320px]"}`}>
                {/* Info summary left of map, same shape as the laps leaderboard */}
                {activeTab === "info" && (
                  <div className="order-2 min-h-[200px] w-full shrink-0 overflow-auto @3xl/workspace:order-1 @3xl/workspace:min-h-0 @3xl/workspace:w-[560px]">
                    <TrackInfoPanel track={track} sectors={displaySectors} sectorBounds={sectorBounds} segSource={segSource} lapCount={trackLaps.length} gameId={gameId} part="summary" />
                  </div>
                )}

                {/* Leaderboard left of map on laps tab */}
                {activeTab === "laps" && (
                  <div className="order-2 min-h-[200px] w-full shrink-0 overflow-hidden @3xl/workspace:order-1 @3xl/workspace:min-h-0 @3xl/workspace:w-[560px]">
                    {isF125 ? <F125Leaderboard trackOrdinal={track.ordinal} /> : <CommunityLeaderboard trackName={track.name} trackVariant={track.variant} />}
                  </div>
                )}
                <TrackCanvasPanel
                  track={track}
                  outline={outline}
                  canvasRef={canvasRef}
                  dragging={dragging}
                  pan={pan}
                  setPan={setPan}
                  zoom={zoom}
                  setZoom={setZoom}
                  sectorBounds={sectorBounds}
                  displaySectors={displaySectors}
                  mapDisplayMode={mapDisplayMode}
                  setMapDisplayMode={setMapDisplayMode}
                  corners={corners}
                  straights={straights}
                />
              </div>
            )}

            {/* Tab content */}
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {/* Setups tab — no outer scroll, component handles its own */}
              {activeTab === "setups" && (
                <div className="flex-1 min-h-0">
                  {isF125 && <F125SetupsWithGuide trackOrdinal={track.ordinal} trackName={track.name} />}
                  {isAcc && <AccTrackSetups trackOrdinal={track.ordinal} />}
                  {hasCatalogSetups && gameId && <CatalogTrackSetups gameId={gameId} trackName={track.name} trackVariant={track.variant} trackOrdinal={track.ordinal} />}
                </div>
              )}

              {activeTab === "guide" && isAcc && (
                <div className="flex-1 min-h-0">
                  <AccTrackGuide trackOrdinal={track.ordinal} trackName={track.name} />
                </div>
              )}
              {activeTab === "guide" && isF125 && (
                <div className="flex-1 min-h-0 p-2">
                  <F125TrackGuide trackOrdinal={track.ordinal} />
                </div>
              )}

              <div className={`min-h-0 flex-1 ${activeTab === "laps" ? "@3xl/workspace:overflow-hidden" : "overflow-auto"} ${activeTab === "setups" || activeTab === "guide" ? "hidden" : ""}`}>
                {/* Info tab — guide + segments read full width under the map */}
                {activeTab === "info" && (
                  <TrackInfoPanel track={track} sectors={displaySectors} sectorBounds={sectorBounds} segSource={segSource} lapCount={trackLaps.length} gameId={gameId} part="details" />
                )}

                {activeTab === "laps" && (
                  <LapManagement
                    track={track}
                    gameId={gameId}
                    trackLaps={trackLaps}
                    filteredLaps={filteredLaps}
                    uniqueCars={uniqueCars}
                    uniqueDivisions={uniqueDivisions}
                    hasForzaTunes={hasForzaTunes}
                    hideClassCol={hideClassCol}
                    selectedDivision={selectedDivision}
                    setSelectedDivision={setSelectedDivision}
                    selectedCars={selectedCars}
                    setSelectedCars={(value) => setSelectedCars(value)}
                    toggleCar={toggleCar}
                    selectedLaps={selectedLaps}
                    setSelectedLaps={(value) => setSelectedLaps(value)}
                    toggleLapSelect={toggleLapSelect}
                    toggleAllLaps={toggleAllLaps}
                    sectorCount={sectorCount}
                    isF125={isF125}
                    hasSessionTypes={hasSessionTypes}
                    sessionLapCounts={sessionLapCounts}
                    confirmDelete={confirmDelete}
                    setConfirmDelete={setConfirmDelete}
                    deleting={deleting}
                    handleBulkDelete={handleBulkDelete}
                    sortBy={sortBy}
                    sortAsc={sortAsc}
                    handleSort={handleSort}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
