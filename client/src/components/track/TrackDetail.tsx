import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { isDevelopment } from "@/lib/env";
import { useNavigate } from "@tanstack/react-router";
import { formatLapTime } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { useBulkDeleteLaps, useDeleteLap } from "@/hooks/queries";
import { useGameId } from "@/stores/game";
import { client } from "@/lib/rpc";
import { drawTrack } from "@/lib/canvas/draw-track";
import { countryName } from "@/lib/country-names";
import { F125SetupsWithGuide } from "@/components/f1/F125TrackSetups";
import { F125Leaderboard } from "@/components/f1/F125Leaderboard";
import { AccTrackSetups, AccTrackGuide } from "@/components/acc/AccTrackSetups";
import { TrackTunes } from "./TrackTunes";
import { Button } from "@/components/ui/button";
import { TrackDebugPanel } from "./debug/TrackDebugPanel";
import type { TrackInfo, Point, TrackSegment, TrackSectors } from "./types";

interface TrackLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  carName: string;
  carClass: string;
  pi: number;
  createdAt?: string;
}

/**
 * TrackDetail — Full-size track view with segment overlay and stats sidebar.
 * Fetches both outline and sector data; segments are color-coded (red=corner, blue=straight).
 */
export function TrackDetail({ track, onBack, initialTab, navigate }: { track: TrackInfo; onBack: () => void; initialTab?: string; navigate: ReturnType<typeof useNavigate> }) {
  const gameId = useGameId();
  const gid = gameId ?? undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
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
  const [trackLaps, setTrackLaps] = useState<TrackLap[]>([]);
  const [selectedCars, setSelectedCars] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"time" | "lap">("time");
  const [sortAsc, setSortAsc] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState<number | null>(null);
  const isF125 = gameId === "f1-2025";
  const isAcc = gameId === "acc";

  // F1 25 track video — shown beside map on setups tab
  const { data: f125Tracks = [] } = useQuery<{ trackSlug: string; trackOrdinal: number; videoUrl: string }[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then(r => r.json() as unknown as { trackSlug: string; trackOrdinal: number; videoUrl: string }[]),
    enabled: isF125,
  });
  const f125VideoUrl = isF125 ? f125Tracks.find(t => t.trackOrdinal === track.ordinal)?.videoUrl : undefined;
  const f125EmbedUrl = f125VideoUrl ? (() => {
    try {
      const u = new URL(f125VideoUrl);
      if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
      if (u.hostname === "youtu.be") return `https://www.youtube.com/embed${u.pathname}`;
    } catch {}
    return null;
  })() : null;
  const hasForzaTunes = !gameId || gameId === "fm-2023";
  const allTabs = hasForzaTunes ? ["laps", "tunes", "debug"] as const
    : isF125 ? ["laps", "setups", "debug"] as const
    : isAcc ? ["laps", "setups", "guide", "debug"] as const
    : ["laps", "debug"] as const;
  type Tab = typeof allTabs[number];
  const validTabs = allTabs;
  const [activeTab, setActiveTabState] = useState<Tab>(
    (validTabs as readonly string[]).includes(initialTab as string) ? (initialTab as Tab) : "laps"
  );
  const setActiveTab = useCallback((tab: Tab) => {
    setActiveTabState(tab);
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, tab: tab === "laps" ? undefined : tab }) as never, replace: true });
  }, [navigate]);
  const navTo = useNavigate();

  useEffect(() => {
    if (!track.hasOutline) return;
    if (!gameId) return;
    Promise.all([
      client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid ?? undefined } }).then((r) => r.json() as unknown as { points?: Point[] } | Point[]),
      client.api["track-sectors"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } }).then((r) => r.json() as unknown as (TrackSectors & { source?: string }) | null),
      client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid! } }).then((r) => r.json() as unknown as { s1End: number; s2End: number } | null),
    ]).then(([outlineData, sectorData, boundsData]) => {
      if (!Array.isArray(outlineData) && outlineData?.points && Array.isArray(outlineData.points)) setOutline(outlineData.points);
      else if (Array.isArray(outlineData)) setOutline(outlineData);
      else setOutline(null);
      setSectors(sectorData);
      setSegSource((sectorData as (TrackSectors & { source?: string }) | null)?.source ?? "");
      if (boundsData?.s1End) setSectorBounds(boundsData);
    }).catch(() => {});
  }, [track.ordinal, track.hasOutline, gameId]);

  // Fetch all laps for this track
  const fetchTrackLaps = useCallback(() => {
    client.api.tracks[":trackOrdinal"].leaderboard.$get({ param: { trackOrdinal: String(track.ordinal) }, query: { gameId: gameId ?? undefined } } as never)
      .then((r) => r.json() as unknown as Record<string, TrackLap[]> | null)
      .then((data) => {
        if (!data) { setTrackLaps([]); return; }
        const all = Object.values(data).flat() as TrackLap[];
        setTrackLaps(all);
        // Initialize car filter to all cars
        setSelectedCars(new Set(all.map((l) => l.carOrdinal)));
      })
      .catch(() => {});
  }, [track.ordinal, gameId]);

  useEffect(() => { fetchTrackLaps(); }, [fetchTrackLaps]);

  // Use edit segments for preview when editing, otherwise use fetched sectors
  const displaySectors = editing && editSegments.length > 0
    ? { segments: editSegments, totalDist: sectors?.totalDist ?? 0 }
    : sectors;

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    const showSectors = editingSectors || mapDisplayMode === "sectors";
    const sectorBoundsForDraw = editingSectors
      ? { s1End: editS1 / 100, s2End: editS2 / 100 }
      : sectorBounds ?? undefined;
    const sectorOverride = showSectors ? sectorBoundsForDraw : undefined;
    drawTrack(canvasRef.current, outline, true, showSectors ? null : displaySectors, zoom, pan, sectorOverride);
  }, [outline, displaySectors, zoom, pan, editingSectors, editS1, editS2, mapDisplayMode, sectorBounds, activeTab]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const factor = Math.pow(0.999, e.deltaY);
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

  const startEditing = useCallback(() => {
    if (sectors?.segments) {
      setEditSegments(sectors.segments.map((s) => ({ ...s })));
      setEditing(true);
    }
  }, [sectors]);

  const updateSegFrac = useCallback((idx: number, field: "startFrac" | "endFrac", value: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx][field] = value;
      // Auto-chain: if changing endFrac, update next segment's startFrac
      if (field === "endFrac" && idx + 1 < next.length) {
        next[idx + 1].startFrac = value;
      }
      // Auto-chain: if changing startFrac, update prev segment's endFrac
      if (field === "startFrac" && idx > 0) {
        next[idx - 1].endFrac = value;
      }
      return next;
    });
  }, []);

  const updateSegName = useCallback((idx: number, name: string) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].name = name;
      return next;
    });
  }, []);

  const toggleSegType = useCallback((idx: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].type = next[idx].type === "corner" ? "straight" : "corner";
      // Clear name when type changes so display auto-name kicks in
      next[idx].name = "";
      return next;
    });
  }, []);

  const addSegment = useCallback((afterIdx: number) => {
    setEditSegments((prev) => {
      const next = [...prev];
      const current = next[afterIdx];
      const midFrac = (current.startFrac + current.endFrac) / 2;
      const newType = current.type === "corner" ? "straight" : "corner";
      const newSeg: TrackSegment = {
        type: newType,
        name: newType === "straight" ? "S?" : "T?",
        startFrac: midFrac,
        endFrac: current.endFrac,
        startIdx: 0,
        endIdx: 0,
      };
      next[afterIdx] = { ...current, endFrac: midFrac };
      next.splice(afterIdx + 1, 0, newSeg);
      return next;
    });
  }, []);

  const removeSegment = useCallback((idx: number) => {
    setEditSegments((prev) => {
      if (prev.length <= 1) return prev;
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      // Extend the previous segment to cover the gap
      if (idx > 0) {
        next[idx - 1] = { ...next[idx - 1], endFrac: removed.endFrac };
      } else if (next.length > 0) {
        next[0] = { ...next[0], startFrac: removed.startFrac };
      }
      return next;
    });
  }, []);

  const saveSegments = useCallback(async () => {
    setSaving(true);
    try {
      const res = await client.api.tracks[":trackOrdinal"].segments.$put({ param: { trackOrdinal: String(track.ordinal) }, query: { gameId: gid }, json: { segments: editSegments } } as never);
      if (res.ok) {
        setSectors({ segments: editSegments, totalDist: sectors?.totalDist ?? 0 });
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }, [editSegments, track.ordinal, sectors]);

  const startEditingSectors = useCallback(() => {
    if (sectorBounds) {
      setEditS1(Math.round(sectorBounds.s1End * 1000) / 10);
      setEditS2(Math.round(sectorBounds.s2End * 1000) / 10);
    }
    setEditingSectors(true);
  }, [sectorBounds]);

  const saveSectorBounds = useCallback(async () => {
    setSavingSectors(true);
    try {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$put({ param: { ordinal: String(track.ordinal) }, query: { gameId: gid }, json: { s1End: editS1 / 100, s2End: editS2 / 100 } } as never);
      if (res.ok) {
        setSectorBounds({ s1End: editS1 / 100, s2End: editS2 / 100 });
        setEditingSectors(false);
      }
    } catch {}
    setSavingSectors(false);
  }, [editS1, editS2, track.ordinal]);

  // Build display names: auto-number empty/unnamed straights
  const segDisplayNames = useMemo(() => {
    const segs = editing ? editSegments : (displaySectors?.segments ?? []);
    let sNum = 1;
    return segs.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) {
        return `S${sNum++}`;
      }
      if (s.type === "straight") sNum++;
      return s.name;
    });
  }, [editing, editSegments, displaySectors]);

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

  const filteredLaps = useMemo(() => {
    return trackLaps
      .filter((l) => selectedCars.has(l.carOrdinal))
      .sort((a, b) => {
        const cmp = sortBy === "time" ? a.lapTime - b.lapTime : a.lapNumber - b.lapNumber;
        return sortAsc ? cmp : -cmp;
      });
  }, [trackLaps, selectedCars, sortBy, sortAsc]);

  const toggleCar = useCallback((ord: number) => {
    setSelectedCars((prev) => {
      const next = new Set(prev);
      if (next.has(ord)) next.delete(ord); else next.add(ord);
      return next;
    });
    setSelectedLaps(new Set());
  }, []);

  const toggleAllCars = useCallback(() => {
    if (selectedCars.size === uniqueCars.length) setSelectedCars(new Set());
    else setSelectedCars(new Set(uniqueCars.map((c) => c.carOrdinal)));
    setSelectedLaps(new Set());
  }, [selectedCars.size, uniqueCars]);

  const toggleLapSelect = useCallback((lapId: number) => {
    setSelectedLaps((prev) => {
      const next = new Set(prev);
      if (next.has(lapId)) next.delete(lapId); else next.add(lapId);
      return next;
    });
  }, []);

  const toggleAllLaps = useCallback(() => {
    if (selectedLaps.size === filteredLaps.length) setSelectedLaps(new Set());
    else setSelectedLaps(new Set(filteredLaps.map((l) => l.lapId)));
  }, [selectedLaps.size, filteredLaps]);

  const bulkDelete = useBulkDeleteLaps();
  const singleDelete = useDeleteLap();

  const handleBulkDelete = useCallback(async () => {
    if (selectedLaps.size === 0) return;
    setDeleting(true);
    try {
      await bulkDelete.mutateAsync(Array.from(selectedLaps));
      setSelectedLaps(new Set());
      setConfirmDelete(false);
      fetchTrackLaps();
    } catch {}
    setDeleting(false);
  }, [selectedLaps, fetchTrackLaps, bulkDelete]);

  const handleSingleDelete = useCallback(async (lapId: number) => {
    await singleDelete.mutateAsync(lapId);
    setSelectedLaps((prev) => { const next = new Set(prev); next.delete(lapId); return next; });
    fetchTrackLaps();
  }, [fetchTrackLaps, singleDelete]);

  const handleSort = useCallback((col: "time" | "lap") => {
    if (sortBy === col) setSortAsc((a) => !a);
    else { setSortBy(col); setSortAsc(true); }
  }, [sortBy]);

  const classTextColors: Record<string, string> = {
    X: "text-green-700", P: "text-green-400", R: "text-blue-400",
    S: "text-purple-400", A: "text-red-400",
    B: "text-orange-400", C: "text-yellow-400", D: "text-cyan-400", E: "text-pink-400",
  };

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-app-label text-app-text-secondary hover:text-app-text px-2 py-1 rounded bg-app-surface-alt hover:bg-app-border-input transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <div className="text-app-heading font-semibold text-app-text">{track.name}</div>
          <div className="text-app-label text-app-text-muted">
            {track.variant} · {track.location}, {countryName(track.country)}
            {track.lengthKm > 0 && ` · ${track.lengthKm} km`}
          </div>
        </div>
        {/* View mode tabs */}
        <div className="flex items-center gap-1">
          {validTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`text-app-label uppercase tracking-wider px-3 py-1.5 rounded transition-colors ${
                activeTab === tab
                  ? tab === "debug" ? "bg-amber-500/15 text-amber-500" : "bg-app-accent/15 text-app-accent"
                  : "text-app-text-muted hover:text-app-text-secondary hover:bg-app-surface-alt"
              }`}
            >
              {tab === "laps" && trackLaps.length > 0 ? `Laps (${trackLaps.length})` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Debug: full-page view */}
      {activeTab === "debug" ? (
        <TrackDebugPanel trackOrdinal={track.ordinal} outline={outline} />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-[calc(100vh-160px)]">
        {/* Left column: Map + Laps */}
        <div className="flex flex-col gap-4 min-h-0 overflow-hidden">
          {/* Track map */}
          <div className="shrink-0" style={{ height: 440 }}>
          <div className="bg-app-bg rounded-lg border border-app-border relative w-full h-full">
            {track.hasOutline ? (
              <canvas
                ref={canvasRef}
                className="w-full h-full cursor-grab active:cursor-grabbing"
                onMouseDown={(e) => {
                  dragging.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanZ: pan.z };
                }}
                onMouseMove={(e) => {
                  if (!dragging.current) return;
                  const dx = e.clientX - dragging.current.startX;
                  const dy = e.clientY - dragging.current.startY;
                  setPan({ x: dragging.current.startPanX + dx, z: dragging.current.startPanZ + dy });
                }}
                onMouseUp={() => { dragging.current = null; }}
                onMouseLeave={() => { dragging.current = null; }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">
                No outline available
              </div>
            )}
            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
              <button
                onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
                className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >+</button>
              <button
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
                className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >-</button>
              {zoom !== 1 && (
                <button
                  onClick={() => { setZoom(1); setPan({ x: 0, z: 0 }); }}
                  className="px-1.5 py-1 text-[9px] font-mono bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded"
                >{zoom % 1 === 0 ? `${zoom}x` : `${zoom.toFixed(2)}x`}</button>
              )}
              {(sectorBounds || displaySectors) && (
                <>
                  <div className="h-px" />
                  <button
                    onClick={() => setMapDisplayMode((m) => m === "segments" ? "sectors" : "segments")}
                    className={`px-1.5 py-1 text-[9px] font-mono rounded border transition-colors ${
                      mapDisplayMode === "sectors"
                        ? "bg-amber-900/50 border-amber-700 text-amber-400"
                        : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
                    }`}
                    title={mapDisplayMode === "sectors" ? "Show segments" : "Show sectors"}
                  >
                    {mapDisplayMode === "sectors" ? "Sectors" : "Segments"}
                  </button>
                </>
              )}
            </div>
          </div>

          </div>

          {/* Tab content */}
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Setups tab — no outer scroll, component handles its own */}
            {activeTab === "setups" && (
              <div className="flex-1 min-h-0">
                {isF125 && <F125SetupsWithGuide trackOrdinal={track.ordinal} trackName={track.name} videoEmbedUrl={f125EmbedUrl} />}
                {isAcc && <AccTrackSetups trackOrdinal={track.ordinal} />}
              </div>
            )}

            {activeTab === "guide" && isAcc && (
              <div className="flex-1 min-h-0">
                <AccTrackGuide trackOrdinal={track.ordinal} trackName={track.name} />
              </div>
            )}

            <div className={`flex-1 min-h-0 overflow-auto ${activeTab === "setups" || activeTab === "guide" ? "hidden" : ""}`}>

              {/* Tunes tab (Forza) */}
              {activeTab === "tunes" && (
                <TrackTunes trackName={track.name} trackVariant={track.variant} />
              )}

              {/* Laps tab */}
              {activeTab === "laps" && (
                <div className={isF125 ? "flex gap-4 h-full overflow-hidden" : "flex flex-col gap-3"}>
                  {/* F1 25: leaderboard on left */}
                  {isF125 && (
                    <div className="w-1/2 min-w-0 overflow-y-auto">
                      <F125Leaderboard trackOrdinal={track.ordinal} />
                    </div>
                  )}

                  {/* Own laps */}
                  <div className={isF125 ? "w-1/2 min-w-0 overflow-y-auto" : "flex flex-col gap-3"}>
                  {trackLaps.length === 0 ? (
                    <div className="text-app-subtext text-app-text-dim py-4 text-center">No laps recorded for this track</div>
                  ) : (
                    <>
                      {/* Car filter */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="text-app-label text-app-text-muted uppercase tracking-wider">Laps ({filteredLaps.length})</div>
                        <button
                          onClick={toggleAllCars}
                          className="text-app-unit px-2 py-0.5 rounded border border-app-border-input text-app-text-secondary hover:text-app-text"
                        >
                          {selectedCars.size === uniqueCars.length ? "None" : "All"}
                        </button>
                        <div className="flex flex-wrap gap-1">
                          {uniqueCars.map((car) => {
                            const active = selectedCars.has(car.carOrdinal);
                            return (
                              <button
                                key={car.carOrdinal}
                                onClick={() => toggleCar(car.carOrdinal)}
                                className={`text-app-unit px-2 py-0.5 rounded border transition-colors ${
                                  active
                                    ? "border-app-accent/50 bg-app-accent/10 text-app-text"
                                    : "border-app-border text-app-text-dim hover:text-app-text-secondary"
                                }`}
                              >
                                <span className={`font-bold font-mono mr-1 ${classTextColors[car.carClass] ?? "text-app-text-secondary"}`}>{car.carClass}</span>
                                {car.carName}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Lap table */}
                      <div className="bg-app-surface/50 rounded-lg border border-app-border overflow-hidden">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-app-border text-app-text-muted text-app-label">
                              <th className="w-8 px-2 py-2 text-left">
                                <input type="checkbox" checked={selectedLaps.size === filteredLaps.length && filteredLaps.length > 0} onChange={toggleAllLaps} className="accent-cyan-400" />
                              </th>
                              <th className="px-2 py-2 text-left">Car</th>
                              <th className="px-2 py-2 text-left">Class</th>
                              <th className="px-2 py-2 text-left cursor-pointer hover:text-app-text select-none" onClick={() => handleSort("lap")}>
                                Lap # {sortBy === "lap" ? (sortAsc ? "▲" : "▼") : ""}
                              </th>
                              <th className="px-2 py-2 text-left cursor-pointer hover:text-app-text select-none" onClick={() => handleSort("time")}>
                                Time {sortBy === "time" ? (sortAsc ? "▲" : "▼") : ""}
                              </th>
                              <th className="px-2 py-2 text-left">Date</th>
                              <th className="px-2 py-2 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredLaps.map((lap) => (
                              <tr key={lap.lapId} className={`border-b border-app-border/50 hover:bg-app-surface-alt/30 ${selectedLaps.has(lap.lapId) ? "bg-cyan-500/5" : ""}`}>
                                <td className="px-2 py-1.5">
                                  <input type="checkbox" checked={selectedLaps.has(lap.lapId)} onChange={() => toggleLapSelect(lap.lapId)} className="accent-cyan-400" />
                                </td>
                                <td className="px-2 py-1.5 text-app-body text-app-text truncate max-w-[200px]">{lap.carName}</td>
                                <td className="px-2 py-1.5 text-app-label">
                                  <span className={`font-bold font-mono ${classTextColors[lap.carClass] ?? "text-app-text-secondary"}`}>{lap.carClass}</span>
                                  <span className="text-app-text-secondary ml-1">PI {lap.pi}</span>
                                </td>
                                <td className="px-2 py-1.5 text-app-label font-mono text-app-text-secondary">{lap.lapNumber}</td>
                                <td className="px-2 py-1.5 text-app-body font-mono tabular-nums text-app-text">{formatLapTime(lap.lapTime)}</td>
                                <td className="px-2 py-1.5 text-app-label text-app-text-secondary whitespace-nowrap font-mono">
                                  {lap.createdAt ? `${new Date(lap.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(lap.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "—"}
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      variant="app-outline"
                                      size="app-sm"
                                      className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70"
                                      onClick={() => navTo({ to: "/fm23/analyse", search: { track: track.ordinal, car: lap.carOrdinal, lap: lap.lapId } })}
                                    >
                                      Analyse
                                    </Button>
                                    {confirmSingleDelete === lap.lapId ? (
                                      <>
                                        <button onClick={() => { handleSingleDelete(lap.lapId); setConfirmSingleDelete(null); }} className="text-app-unit px-1.5 py-0.5 rounded text-white bg-red-600 hover:bg-red-500">Confirm</button>
                                        <button onClick={() => setConfirmSingleDelete(null)} className="text-app-unit px-1.5 py-0.5 rounded text-app-text-secondary hover:text-app-text bg-app-surface-alt">Cancel</button>
                                      </>
                                    ) : (
                                      <button onClick={() => setConfirmSingleDelete(lap.lapId)} className="text-app-unit px-1.5 py-0.5 rounded text-red-400 hover:text-red-300 bg-red-900/20 hover:bg-red-900/40">Delete</button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                            {filteredLaps.length === 0 && (
                              <tr><td colSpan={6} className="px-2 py-4 text-center text-app-subtext text-app-text-dim">No laps match the selected filters</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Action bar */}
                      {selectedLaps.size > 0 && (
                        <div className="flex items-center gap-2 p-2 bg-app-surface-alt/50 rounded-lg border border-app-border">
                          <span className="text-app-label text-app-text-secondary">{selectedLaps.size} selected</span>
                          <div className="flex-1" />
                          {selectedLaps.size === 2 && (() => {
                            const [lapA, lapB] = Array.from(selectedLaps);
                            return (
                              <button
                                onClick={() => navTo({ to: "/fm23/compare", search: { track: track.ordinal, lapA, lapB, carA: trackLaps.find((l) => l.lapId === lapA)?.carOrdinal, carB: trackLaps.find((l) => l.lapId === lapB)?.carOrdinal } })}
                                className="text-xs px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium"
                              >Compare</button>
                            );
                          })()}
                          {!confirmDelete ? (
                            <button onClick={() => setConfirmDelete(true)} className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white font-medium">
                              Delete ({selectedLaps.size})
                            </button>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className="text-app-label text-red-400">Confirm?</span>
                              <button onClick={handleBulkDelete} disabled={deleting} className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50">{deleting ? "..." : "Yes, delete"}</button>
                              <button onClick={() => setConfirmDelete(false)} className="text-xs px-2 py-1 rounded bg-app-surface-alt text-app-text-secondary hover:text-app-text">Cancel</button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* Right column: Track Info + Segments + Sector Boundaries */}
        <div className="flex flex-col gap-3 overflow-auto h-full">
          {/* Track Info */}
          <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
            <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Track Info</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-app-text-muted text-app-label">Length</span>
                <div className="font-mono text-app-text text-app-body">{track.lengthKm > 0 ? `${track.lengthKm} km` : "—"}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-app-label">Corners</span>
                <div className="font-mono text-app-text text-app-body">{corners.length}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-app-label">Straights</span>
                <div className="font-mono text-app-text text-app-body">{straights.length}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-app-label">Segments</span>
                <div className="font-mono text-app-text text-app-body">{displaySectors?.segments.length ?? 0}</div>
              </div>
              {track.createdAt && (
                <div className="col-span-2">
                  <span className="text-app-text-muted text-app-label">Created</span>
                  <div className="font-mono text-app-text text-app-label">
                    {new Date(track.createdAt).toLocaleDateString()} {new Date(track.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Segment list / editor */}
          {displaySectors && displaySectors.segments.length > 0 && (
            <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-app-label text-app-text-muted uppercase tracking-wider">Segments</span>
                  {segSource && (
                    <span className="text-[9px] font-mono text-app-text-dim px-1 py-0.5 rounded bg-app-surface-alt border border-app-border-input">
                      {segSource}
                    </span>
                  )}
                </div>
                {isDevelopment && (!editing ? (
                  <button onClick={startEditing} className="text-app-unit text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50">Edit</button>
                ) : (
                  <div className="flex gap-1">
                    <button onClick={saveSegments} disabled={saving} className="text-app-unit text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50">{saving ? "..." : "Save"}</button>
                    <button onClick={() => setEditing(false)} className="text-app-unit text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input">Cancel</button>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-0.5 max-h-[300px] overflow-auto">
                {(editing ? editSegments : displaySectors.segments).map((seg, i) => {
                  const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
                  const isCorner = seg.type === "corner";
                  const color = isCorner ? "text-red-400" : "text-blue-400";
                  const bg = isCorner ? "bg-red-500/10" : "bg-blue-500/10";
                  if (!editing) {
                    return (
                      <div key={i} className={`flex items-center justify-between px-2 py-1 rounded ${bg}`}>
                        <div className="flex items-center gap-2">
                          <span className={`text-app-label font-mono font-bold ${color}`}>{segDisplayNames[i]}</span>
                          <span className="text-app-label text-app-text-muted capitalize">{seg.type}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {track.lengthKm > 0 && <span className="text-app-label font-mono text-app-text-dim">{((seg.endFrac - seg.startFrac) * track.lengthKm).toFixed(2)} km</span>}
                          <span className="text-app-label font-mono text-app-text-secondary">{pct}%</span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className={`px-2 py-1.5 rounded ${bg} space-y-1`}>
                      <div className="flex items-center gap-1">
                        <button onClick={() => toggleSegType(i)} className={`text-app-unit font-bold px-1 rounded ${isCorner ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>{isCorner ? "T" : "S"}</button>
                        <input value={seg.name} placeholder={segDisplayNames[i]} onChange={(e) => updateSegName(i, e.target.value)} className="flex-1 text-app-label font-mono bg-transparent border-b border-app-border-input text-app-text outline-none px-1 placeholder:text-app-text-dim" />
                        <button onClick={() => addSegment(i)} className="text-app-unit text-app-text-muted hover:text-app-text px-1" title="Split segment">+</button>
                        <button onClick={() => removeSegment(i)} className="text-app-unit text-app-text-muted hover:text-red-400 px-1" title="Remove segment">x</button>
                      </div>
                      <div className="flex items-center gap-2 text-app-label font-mono text-app-text-secondary">
                        <input type="number" step="0.1" min="0" max="100" value={(seg.startFrac * 100).toFixed(1)} onChange={(e) => updateSegFrac(i, "startFrac", Number(e.target.value) / 100)} className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                        <span>-</span>
                        <input type="number" step="0.1" min="0" max="100" value={(seg.endFrac * 100).toFixed(1)} onChange={(e) => updateSegFrac(i, "endFrac", Number(e.target.value) / 100)} className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                        <span className="text-app-text-dim">({pct}%)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Sector Boundaries */}
          <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-app-label text-app-text-muted uppercase tracking-wider">Sector Boundaries</div>
              {isDevelopment && (!editingSectors ? (
                <button onClick={startEditingSectors} disabled={!sectorBounds} className="text-app-unit text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50 disabled:opacity-50">Edit</button>
              ) : (
                <div className="flex gap-1">
                  <button onClick={saveSectorBounds} disabled={savingSectors} className="text-app-unit text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50">{savingSectors ? "..." : "Save"}</button>
                  <button onClick={() => setEditingSectors(false)} className="text-app-unit text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input">Cancel</button>
                </div>
              ))}
            </div>
            {sectorBounds ? (
              editingSectors ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-app-label text-app-text-muted w-16">S1 End</span>
                    <input type="number" step="0.1" min="1" max={editS2 - 1} value={editS1.toFixed(1)} onChange={(e) => setEditS1(Number(e.target.value))} className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                    <span className="text-app-label text-app-text-dim">%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-app-label text-app-text-muted w-16">S2 End</span>
                    <input type="number" step="0.1" min={editS1 + 1} max="99" value={editS2.toFixed(1)} onChange={(e) => setEditS2(Number(e.target.value))} className="w-16 text-app-label font-mono bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center" />
                    <span className="text-app-label text-app-text-dim">%</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span className="text-app-label text-app-text-muted w-16">S3 End</span>
                    <span className="text-app-label font-mono text-app-text-secondary">100.0</span>
                    <span className="text-app-label text-app-text-dim">% (finish)</span>
                  </div>
                  <div className="flex h-2 rounded overflow-hidden mt-1">
                    <div className="bg-red-500/60" style={{ width: `${editS1}%` }} />
                    <div className="bg-blue-500/60" style={{ width: `${editS2 - editS1}%` }} />
                    <div className="bg-yellow-500/60" style={{ width: `${100 - editS2}%` }} />
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {[
                    { name: "S1", color: "bg-red-500", frac: sectorBounds.s1End },
                    { name: "S2", color: "bg-blue-500", frac: sectorBounds.s2End - sectorBounds.s1End },
                    { name: "S3", color: "bg-yellow-500", frac: 1 - sectorBounds.s2End },
                  ].map((s) => (
                    <div key={s.name} className="flex items-center gap-2 px-2 py-1 rounded bg-app-surface-alt/30">
                      <div className={`w-2 h-2 rounded-full ${s.color}`} />
                      <span className="text-app-label font-mono font-bold text-app-text">{s.name}</span>
                      {track.lengthKm > 0 && (
                        <span className="text-app-label font-mono text-app-text-dim">{(s.frac * track.lengthKm).toFixed(2)} km</span>
                      )}
                      <span className="text-app-label font-mono text-app-text-secondary ml-auto">{(s.frac * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  <div className="flex h-2 rounded overflow-hidden mt-1">
                    <div className="bg-red-500/60" style={{ width: `${sectorBounds.s1End * 100}%` }} />
                    <div className="bg-blue-500/60" style={{ width: `${(sectorBounds.s2End - sectorBounds.s1End) * 100}%` }} />
                    <div className="bg-yellow-500/60" style={{ width: `${(1 - sectorBounds.s2End) * 100}%` }} />
                  </div>
                </div>
              )
            ) : (
              <div className="text-app-label text-app-text-dim">No sector data available</div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
