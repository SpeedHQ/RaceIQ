import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { formatLapTime } from "./LiveTelemetry";
import { TUNE_CATALOG, getCatalogCar, type CatalogTune } from "../data/tune-catalog";

interface TrackInfo {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  hasOutline: boolean;
}

interface Point {
  x: number;
  z: number;
}

interface TrackSegment {
  type: "corner" | "straight";
  name: string;
  startFrac: number;
  endFrac: number;
  startIdx: number;
  endIdx: number;
}

interface TrackSectors {
  segments: TrackSegment[];
  totalDist: number;
}

/** TrackCard — Gallery thumbnail: fetches outline by ordinal and renders a small static track map. */
function TrackCard({ track, onSelect }: { track: TrackInfo; onSelect: (t: TrackInfo) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);

  useEffect(() => {
    if (!track.hasOutline) return;
    fetch(`/api/track-outline/${track.ordinal}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.points && Array.isArray(data.points)) setOutline(data.points);
        else if (Array.isArray(data)) setOutline(data);
        else setOutline(null);
      })
      .catch(() => {});
  }, [track.ordinal, track.hasOutline]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, false, null);
  }, [outline]);

  return (
    <div
      className="border border-app-border rounded-lg overflow-hidden cursor-pointer transition-all bg-app-surface/50 hover:border-app-border-input hover:bg-app-surface-alt/50"
      onClick={() => onSelect(track)}
    >
      <div className="p-3">
        <div className="text-sm font-medium text-app-text">{track.name}</div>
        <div className="text-xs text-app-text-muted">
          {track.variant} &middot; {track.location}, {track.country.toUpperCase()}
          {track.lengthKm > 0 && ` &middot; ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-app-bg" style={{ height: 150 }}>
        {track.hasOutline ? (
          <canvas ref={canvasRef} className="w-full h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-app-text-dim">
            No outline available
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * TrackDetail — Full-size track view with segment overlay and stats sidebar.
 * Fetches both outline and sector data; segments are color-coded (red=corner, blue=straight).
 */
function TrackDetail({ track, onBack }: { track: TrackInfo; onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, z: 0 });
  const dragging = useRef<{ startX: number; startY: number; startPanX: number; startPanZ: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editSegments, setEditSegments] = useState<TrackSegment[]>([]);
  const [saving, setSaving] = useState(false);
  interface TrackLap {
    lapId: number;
    lapNumber: number;
    lapTime: number;
    carOrdinal: number;
    carName: string;
    carClass: string;
    pi: number;
  }
  const [trackLaps, setTrackLaps] = useState<TrackLap[]>([]);
  const [selectedCars, setSelectedCars] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"time" | "lap">("time");
  const [sortAsc, setSortAsc] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"laps" | "tunes">("laps");
  const navigate = useNavigate();

  useEffect(() => {
    if (!track.hasOutline) return;
    Promise.all([
      fetch(`/api/track-outline/${track.ordinal}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/track-sectors/${track.ordinal}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([outlineData, sectorData]) => {
      if (outlineData?.points && Array.isArray(outlineData.points)) setOutline(outlineData.points);
      else if (Array.isArray(outlineData)) setOutline(outlineData);
      else setOutline(null);
      setSectors(sectorData);
    }).catch(() => {});
  }, [track.ordinal, track.hasOutline]);

  // Fetch all laps for this track
  const fetchTrackLaps = useCallback(() => {
    fetch(`/api/tracks/${track.ordinal}/leaderboard`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, TrackLap[]> | null) => {
        if (!data) { setTrackLaps([]); return; }
        const all = Object.values(data).flat();
        setTrackLaps(all);
        // Initialize car filter to all cars
        setSelectedCars(new Set(all.map((l) => l.carOrdinal)));
      })
      .catch(() => {});
  }, [track.ordinal]);

  useEffect(() => { fetchTrackLaps(); }, [fetchTrackLaps]);

  // Use edit segments for preview when editing, otherwise use fetched sectors
  const displaySectors = editing && editSegments.length > 0
    ? { segments: editSegments, totalDist: sectors?.totalDist ?? 0 }
    : sectors;

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, true, displaySectors, zoom, pan);
  }, [outline, displaySectors, zoom, pan]);

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
      const res = await fetch(`/api/tracks/${track.ordinal}/segments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: editSegments }),
      });
      if (res.ok) {
        setSectors({ segments: editSegments, totalDist: sectors?.totalDist ?? 0 });
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }, [editSegments, track.ordinal, sectors]);

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
    let laps = trackLaps.filter((l) => selectedCars.has(l.carOrdinal));
    laps.sort((a, b) => {
      const cmp = sortBy === "time" ? a.lapTime - b.lapTime : a.lapNumber - b.lapNumber;
      return sortAsc ? cmp : -cmp;
    });
    return laps;
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

  const handleBulkDelete = useCallback(async () => {
    if (selectedLaps.size === 0) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/laps/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedLaps) }),
      });
      if (res.ok) {
        setSelectedLaps(new Set());
        setConfirmDelete(false);
        fetchTrackLaps();
      }
    } catch {}
    setDeleting(false);
  }, [selectedLaps, fetchTrackLaps]);

  const handleSingleDelete = useCallback(async (lapId: number) => {
    await fetch(`/api/laps/${lapId}`, { method: "DELETE" });
    setSelectedLaps((prev) => { const next = new Set(prev); next.delete(lapId); return next; });
    fetchTrackLaps();
  }, [fetchTrackLaps]);

  const handleSort = useCallback((col: "time" | "lap") => {
    if (sortBy === col) setSortAsc((a) => !a);
    else { setSortBy(col); setSortAsc(true); }
  }, [sortBy]);

  const classTextColors: Record<string, string> = {
    X: "text-purple-400", P: "text-pink-400", R: "text-red-400",
    S2: "text-orange-400", S1: "text-amber-400", A: "text-green-400",
    B: "text-blue-400", C: "text-cyan-400", D: "text-slate-400",
  };

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-xs text-app-text-secondary hover:text-app-text px-2 py-1 rounded bg-app-surface-alt hover:bg-app-border-input transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <div className="text-lg font-semibold text-app-text">{track.name}</div>
          <div className="text-xs text-app-text-muted">
            {track.variant} &middot; {track.location}, {track.country.toUpperCase()}
            {track.lengthKm > 0 && ` &middot; ${track.lengthKm} km`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Large track map */}
        <div className="bg-app-bg rounded-lg border border-app-border relative" style={{ height: 600 }}>
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
            <div className="flex items-center justify-center h-full text-xs text-app-text-dim">
              No outline available
            </div>
          )}
          {/* Zoom controls */}
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            <button
              onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
              className="w-7 h-7 text-sm bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >+</button>
            <button
              onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
              className="w-7 h-7 text-sm bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >-</button>
            {zoom !== 1 && (
              <button
                onClick={() => { setZoom(1); setPan({ x: 0, z: 0 }); }}
                className="w-7 h-7 text-[10px] bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
              >1x</button>
            )}
          </div>
        </div>

        {/* Track info sidebar */}
        <div className="flex flex-col gap-3">
          {/* Stats */}
          <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
            <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">Track Info</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-app-text-muted text-xs">Length</span>
                <div className="font-mono text-app-text">{track.lengthKm > 0 ? `${track.lengthKm} km` : "—"}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-xs">Corners</span>
                <div className="font-mono text-app-text">{corners.length}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-xs">Straights</span>
                <div className="font-mono text-app-text">{straights.length}</div>
              </div>
              <div>
                <span className="text-app-text-muted text-xs">Segments</span>
                <div className="font-mono text-app-text">{displaySectors?.segments.length ?? 0}</div>
              </div>
            </div>
          </div>

          {/* Segment list / editor */}
          {displaySectors && displaySectors.segments.length > 0 && (
            <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-app-text-muted uppercase tracking-wider">Segments</div>
                {!editing ? (
                  <button
                    onClick={startEditing}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50"
                  >
                    Edit
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <button
                      onClick={saveSegments}
                      disabled={saving}
                      className="text-[10px] text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50"
                    >
                      {saving ? "..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className="text-[10px] text-app-text-secondary hover:text-app-text px-2 py-0.5 rounded bg-app-surface-alt border border-app-border-input"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-0.5 max-h-[420px] overflow-auto">
                {(editing ? editSegments : displaySectors.segments).map((seg, i) => {
                  const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
                  const isCorner = seg.type === "corner";
                  const color = isCorner ? "text-red-400" : "text-blue-400";
                  const bg = isCorner ? "bg-red-500/10" : "bg-blue-500/10";

                  if (!editing) {
                    return (
                      <div key={i} className={`flex items-center justify-between px-2 py-1 rounded ${bg}`}>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-mono font-bold ${color}`}>{segDisplayNames[i]}</span>
                          <span className="text-[10px] text-app-text-muted capitalize">{seg.type}</span>
                        </div>
                        <span className="text-[10px] font-mono text-app-text-secondary">{pct}%</span>
                      </div>
                    );
                  }

                  return (
                    <div key={i} className={`px-2 py-1.5 rounded ${bg} space-y-1`}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleSegType(i)}
                          className={`text-[10px] font-bold px-1 rounded ${isCorner ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}
                        >
                          {isCorner ? "T" : "S"}
                        </button>
                        <input
                          value={seg.name}
                          placeholder={segDisplayNames[i]}
                          onChange={(e) => updateSegName(i, e.target.value)}
                          className="flex-1 text-xs font-mono bg-transparent border-b border-app-border-input text-app-text outline-none px-1 placeholder:text-app-text-dim"
                        />
                        <button
                          onClick={() => addSegment(i)}
                          className="text-[10px] text-app-text-muted hover:text-app-text px-1"
                          title="Split segment"
                        >+</button>
                        <button
                          onClick={() => removeSegment(i)}
                          className="text-[10px] text-app-text-muted hover:text-red-400 px-1"
                          title="Remove segment"
                        >x</button>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-app-text-secondary">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={(seg.startFrac * 100).toFixed(1)}
                          onChange={(e) => updateSegFrac(i, "startFrac", Number(e.target.value) / 100)}
                          className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
                        />
                        <span>-</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={(seg.endFrac * 100).toFixed(1)}
                          onChange={(e) => updateSegFrac(i, "endFrac", Number(e.target.value) / 100)}
                          className="w-14 bg-app-surface-alt border border-app-border-input rounded px-1 py-0.5 text-app-text text-center"
                        />
                        <span className="text-app-text-dim">({pct}%)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4">
        <div className="flex items-center gap-1 border-b border-app-border mb-3">
          <button
            onClick={() => setActiveTab("laps")}
            className={`text-xs uppercase tracking-wider px-3 py-1.5 -mb-px border-b-2 transition-colors ${
              activeTab === "laps"
                ? "border-app-accent text-app-accent"
                : "border-transparent text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            Laps {trackLaps.length > 0 && `(${trackLaps.length})`}
          </button>
          <button
            onClick={() => setActiveTab("tunes")}
            className={`text-xs uppercase tracking-wider px-3 py-1.5 -mb-px border-b-2 transition-colors ${
              activeTab === "tunes"
                ? "border-app-accent text-app-accent"
                : "border-transparent text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            Tunes
          </button>
        </div>

        {activeTab === "tunes" && (
          <TrackTunes trackName={track.name} trackVariant={track.variant} />
        )}

      {/* Lap Manager */}
      {activeTab === "laps" && trackLaps.length > 0 && (
        <div>
          {/* Car filter */}
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Laps ({filteredLaps.length})</div>
            <button
              onClick={toggleAllCars}
              className="text-[10px] px-2 py-0.5 rounded border border-app-border-input text-app-text-secondary hover:text-app-text"
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
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
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
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-app-border text-app-text-muted">
                  <th className="w-8 px-2 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={selectedLaps.size === filteredLaps.length && filteredLaps.length > 0}
                      onChange={toggleAllLaps}
                      className="accent-cyan-400"
                    />
                  </th>
                  <th className="px-2 py-2 text-left">Car</th>
                  <th className="px-2 py-2 text-left">Class</th>
                  <th
                    className="px-2 py-2 text-left cursor-pointer hover:text-app-text select-none"
                    onClick={() => handleSort("lap")}
                  >
                    Lap # {sortBy === "lap" ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                  <th
                    className="px-2 py-2 text-left cursor-pointer hover:text-app-text select-none"
                    onClick={() => handleSort("time")}
                  >
                    Time {sortBy === "time" ? (sortAsc ? "▲" : "▼") : ""}
                  </th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredLaps.map((lap) => (
                  <tr
                    key={lap.lapId}
                    className={`border-b border-app-border/50 hover:bg-app-surface-alt/30 ${
                      selectedLaps.has(lap.lapId) ? "bg-cyan-500/5" : ""
                    }`}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selectedLaps.has(lap.lapId)}
                        onChange={() => toggleLapSelect(lap.lapId)}
                        className="accent-cyan-400"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-app-text truncate max-w-[200px]">{lap.carName}</td>
                    <td className="px-2 py-1.5">
                      <span className={`font-bold font-mono ${classTextColors[lap.carClass] ?? "text-app-text-secondary"}`}>{lap.carClass}</span>
                      <span className="text-app-text-dim ml-1">PI {lap.pi}</span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-app-text-secondary">{lap.lapNumber}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums text-app-text">{formatLapTime(lap.lapTime)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => navigate({ to: "/analyse", search: { track: track.ordinal, car: lap.carOrdinal, lap: lap.lapId } })}
                          className="text-[10px] px-1.5 py-0.5 rounded text-cyan-400 hover:text-cyan-300 bg-cyan-900/20 hover:bg-cyan-900/40"
                        >
                          Analyse
                        </button>
                        {confirmSingleDelete === lap.lapId ? (
                          <>
                            <button
                              onClick={() => { handleSingleDelete(lap.lapId); setConfirmSingleDelete(null); }}
                              className="text-[10px] px-1.5 py-0.5 rounded text-white bg-red-600 hover:bg-red-500"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmSingleDelete(null)}
                              className="text-[10px] px-1.5 py-0.5 rounded text-app-text-secondary hover:text-app-text bg-app-surface-alt"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmSingleDelete(lap.lapId)}
                            className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:text-red-300 bg-red-900/20 hover:bg-red-900/40"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredLaps.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-4 text-center text-app-text-dim">
                      No laps match the selected filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Action bar */}
          {selectedLaps.size > 0 && (
            <div className="mt-3 flex items-center gap-2 p-2 bg-app-surface-alt/50 rounded-lg border border-app-border">
              <span className="text-xs text-app-text-secondary">{selectedLaps.size} selected</span>
              <div className="flex-1" />
              {selectedLaps.size === 2 && (() => {
                const [lapA, lapB] = Array.from(selectedLaps);
                return (
                  <button
                    onClick={() => navigate({ to: "/compare", search: {
                      track: track.ordinal,
                      lapA,
                      lapB,
                      carA: trackLaps.find((l) => l.lapId === lapA)?.carOrdinal,
                      carB: trackLaps.find((l) => l.lapId === lapB)?.carOrdinal,
                    } })}
                    className="text-xs px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium"
                  >
                    Compare
                  </button>
                );
              })()}
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs px-3 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white font-medium"
                >
                  Delete ({selectedLaps.size})
                </button>
              ) : (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-red-400">Confirm?</span>
                  <button
                    onClick={handleBulkDelete}
                    disabled={deleting}
                    className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50"
                  >
                    {deleting ? "..." : "Yes, delete"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-xs px-2 py-1 rounded bg-app-surface-alt text-app-text-secondary hover:text-app-text"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function TrackTunes({ trackName, trackVariant }: { trackName: string; trackVariant: string }) {
  const fullName = trackVariant ? `${trackName} ${trackVariant}`.trim() : trackName;
  const nameLower = fullName.toLowerCase();
  const trackNameLower = trackName.toLowerCase();
  const [carSearch, setCarSearch] = useState("");
  const [expandedTune, setExpandedTune] = useState<string | null>(null);

  const allTunes = TUNE_CATALOG.filter((t) =>
    t.bestTracks?.some((bt) => {
      const btl = bt.toLowerCase();
      return btl.includes(nameLower) || nameLower.includes(btl) || btl.includes(trackNameLower) || trackNameLower.includes(btl);
    }) || t.category === "track-specific"
  );

  const carQuery = carSearch.toLowerCase();
  const tunes = carQuery
    ? allTunes.filter((t) => {
        const carName = getCatalogCar(t.carOrdinal)?.name ?? "";
        return carName.toLowerCase().includes(carQuery);
      })
    : allTunes;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="text-xs text-app-text-muted uppercase tracking-wider whitespace-nowrap">
          Tunes ({tunes.length})
        </div>
        <input
          type="text"
          value={carSearch}
          onChange={(e) => setCarSearch(e.target.value)}
          placeholder="Search cars..."
          className="h-7 w-full max-w-xs rounded-md border border-app-border-input bg-app-dropdown px-2.5 text-sm text-app-text placeholder:text-app-text-dim outline-none focus:border-app-text-muted transition-colors"
        />
      </div>

      {tunes.length === 0 ? (
        <div className="text-center py-12 text-app-text-dim text-sm">
          No tunes found{carSearch ? ` matching "${carSearch}"` : " for this track"}.
        </div>
      ) : (
        <div className="space-y-2">
          {tunes.map((tune) => {
            const isExpanded = expandedTune === tune.id;
            return (
              <div key={tune.id} className="rounded-lg bg-app-surface border border-app-border overflow-hidden">
                <button
                  onClick={() => setExpandedTune(isExpanded ? null : tune.id)}
                  className="w-full text-left p-3 hover:bg-app-surface-alt/30 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-app-text">{tune.name}</span>
                    <span className="text-[10px] font-mono text-app-text-muted">
                      {getCatalogCar(tune.carOrdinal)?.name ?? `Car ${tune.carOrdinal}`}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                      tune.category === "circuit" ? "bg-blue-500/20 text-blue-400" :
                      tune.category === "wet" ? "bg-cyan-500/20 text-cyan-400" :
                      tune.category === "low-drag" ? "bg-red-500/20 text-red-400" :
                      tune.category === "stable" ? "bg-green-500/20 text-green-400" :
                      "bg-orange-500/20 text-orange-400"
                    }`}>
                      {tune.category}
                    </span>
                    <svg
                      className={`w-3.5 h-3.5 text-app-text-muted ml-auto shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <p className={`text-xs text-app-text-secondary mt-1 ${isExpanded ? "" : "line-clamp-1"}`}>{tune.description}</p>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-app-border">
                    {/* Strengths & Weaknesses */}
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-1">Strengths</h4>
                        <ul className="space-y-0.5">
                          {tune.strengths.map((s) => (
                            <li key={s} className="text-xs text-app-text-secondary flex items-start gap-1.5">
                              <span className="text-green-400 mt-0.5">+</span> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">Weaknesses</h4>
                        <ul className="space-y-0.5">
                          {tune.weaknesses.map((w) => (
                            <li key={w} className="text-xs text-app-text-secondary flex items-start gap-1.5">
                              <span className="text-red-400 mt-0.5">-</span> {w}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {/* Best Tracks */}
                    {tune.bestTracks && tune.bestTracks.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-1">Best Tracks</h4>
                        <div className="flex flex-wrap gap-1">
                          {tune.bestTracks.map((bt) => (
                            <span key={bt} className="text-[10px] px-2 py-0.5 rounded-full bg-app-surface-alt text-app-text-secondary border border-app-border">
                              {bt}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Tune Settings */}
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted mb-1">Settings</h4>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div className="flex justify-between"><span className="text-app-text-muted">Front Pressure</span><span className="font-mono text-app-text">{tune.settings.tires.frontPressure.toFixed(2)} bar</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Rear Pressure</span><span className="font-mono text-app-text">{tune.settings.tires.rearPressure.toFixed(2)} bar</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Final Drive</span><span className="font-mono text-app-text">{tune.settings.gearing.finalDrive.toFixed(2)}</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Front Camber</span><span className="font-mono text-app-text">{tune.settings.alignment.frontCamber.toFixed(1)}&deg;</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Rear Camber</span><span className="font-mono text-app-text">{tune.settings.alignment.rearCamber.toFixed(1)}&deg;</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Front ARB</span><span className="font-mono text-app-text">{tune.settings.antiRollBars.front.toFixed(1)}</span></div>
                        <div className="flex justify-between"><span className="text-app-text-muted">Rear ARB</span><span className="font-mono text-app-text">{tune.settings.antiRollBars.rear.toFixed(1)}</span></div>
                      </div>
                    </div>

                    <div className="text-[10px] text-app-text-dim">by {tune.author}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * drawTrack — Shared canvas rendering for both gallery thumbnails and detail views.
 * Draws a thick base outline, then overlays color-coded segments (corner/straight).
 * Segment labels are offset perpendicular to the track direction so they don't overlap the line.
 * The perpendicular offset is computed from neighboring outline points' tangent vector.
 */
function drawTrack(canvas: HTMLCanvasElement, outline: Point[], large: boolean, sectors?: TrackSectors | null, zoom: number = 1, pan: { x: number; z: number } = { x: 0, z: 0 }) {
  const ctx = canvas.getContext("2d");
  if (!ctx || outline.length < 2) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const rangeX = (maxX - minX) || 1;
  const rangeZ = (maxZ - minZ) || 1;
  const padding = large ? 20 : 12;
  const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
  const scale = baseScale * zoom;
  const offsetX = (w - rangeX * scale) / 2 + pan.x;
  const offsetZ = (h - rangeZ * scale) / 2 + pan.z;

  function toCanvas(x: number, z: number): [number, number] {
    return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
  }

  // Track outline
  ctx.beginPath();
  ctx.strokeStyle = large ? "#475569" : "#334155";
  ctx.lineWidth = large ? 4 : 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < outline.length; i++) {
    const [px, py] = toCanvas(outline[i].x, outline[i].z);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(sx, sy);
  ctx.stroke();

  // Inner line — color-coded by segment type. startFrac/endFrac map [0,1] to outline indices.
  // Alternating color palettes for distinct segment visibility
  const cornerColors = ["#ef4444", "#f97316", "#ec4899", "#f59e0b", "#e11d48", "#d946ef"];
  const straightColors = ["#3b82f6", "#06b6d4", "#8b5cf6", "#2dd4bf", "#6366f1", "#0ea5e9"];

  if (sectors && sectors.segments.length > 0) {
    const n = outline.length;
    let cornerIdx = 0, straightIdx = 0;

    // Build display names: auto-number unnamed straights
    let sNum = 1;
    const displayNames = sectors.segments.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
      if (s.type === "straight") sNum++;
      return s.name;
    });

    let segIdx = 0;
    for (const seg of sectors.segments) {
      const displayName = displayNames[segIdx++];
      const start = Math.round(seg.startFrac * n);
      const end = Math.min(Math.round(seg.endFrac * n), n - 1);
      const color = seg.type === "corner"
        ? cornerColors[cornerIdx++ % cornerColors.length]
        : straightColors[straightIdx++ % straightColors.length];

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = large ? 0.85 : 0.5;
      ctx.lineWidth = large ? 3 : 1.5;
      ctx.lineCap = "round";
      const [fx, fy] = toCanvas(outline[start].x, outline[start].z);
      ctx.moveTo(fx, fy);
      for (let i = start + 1; i <= end; i++) {
        const [px, py] = toCanvas(outline[i].x, outline[i].z);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Boundary dot at segment start
      if (large && start > 0) {
        ctx.beginPath();
        ctx.arc(fx, fy, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Label at midpoint of segment
      if (large || seg.type === "corner") {
        const midIdx = Math.round((start + end) / 2);
        const midPt = outline[Math.min(midIdx, n - 1)];
        const [mx, my] = toCanvas(midPt.x, midPt.z);

        // Offset label away from track using perpendicular
        const prevIdx = Math.max(0, midIdx - 2);
        const nextIdx = Math.min(n - 1, midIdx + 2);
        const dx = outline[nextIdx].x - outline[prevIdx].x;
        const dz = outline[nextIdx].z - outline[prevIdx].z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const offDist = large ? 14 : 8;
        const lx = mx + (-dz / len) * offDist;
        const ly = my + (dx / len) * offDist;

        ctx.font = large ? "bold 9px monospace" : "bold 7px monospace";
        ctx.textAlign = "center";
        // Background pill behind label
        const textWidth = ctx.measureText(displayName).width;
        const padX = 3, padY = 2;
        ctx.globalAlpha = large ? 0.85 : 0.6;
        ctx.fillStyle = "#0f172a";
        ctx.beginPath();
        ctx.roundRect(lx - textWidth / 2 - padX, ly + 3 - 7 - padY, textWidth + padX * 2, 10 + padY * 2, 3);
        ctx.fill();
        // Label text
        ctx.globalAlpha = large ? 0.95 : 0.8;
        ctx.fillStyle = color;
        ctx.fillText(displayName, lx, ly + 3);
        ctx.globalAlpha = 1;
      }
    }
  } else {
    ctx.beginPath();
    ctx.strokeStyle = large ? "#94a3b8" : "#64748b";
    ctx.lineWidth = large ? 2 : 1.5;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  // Start marker
  ctx.beginPath();
  ctx.arc(sx, sy, large ? 5 : 3, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();

  // Direction arrow from start point — use ~0.5% of outline (just a few meters ahead)
  const arrowIdx = Math.min(Math.max(3, Math.floor(outline.length * 0.005)), outline.length - 1);
  if (arrowIdx > 0) {
    const [ax, ay] = toCanvas(outline[arrowIdx].x, outline[arrowIdx].z);
    const dx = ax - sx;
    const dy = ay - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 3) {
      const nx = dx / len;
      const ny = dy / len;
      const arrowLen = large ? 18 : 12;
      const wingLen = large ? 5 : 3;
      const tipX = sx + nx * arrowLen;
      const tipY = sy + ny * arrowLen;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = large ? 2 : 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - nx * wingLen * 2 + ny * wingLen, tipY - ny * wingLen * 2 - nx * wingLen);
      ctx.lineTo(tipX - nx * wingLen * 2 - ny * wingLen, tipY - ny * wingLen * 2 + nx * wingLen);
      ctx.closePath();
      ctx.fillStyle = "#10b981";
      ctx.fill();
    }
  }
}

/** TrackViewer — Gallery view of all known tracks, split into "with outlines" and "without". */
export function TrackViewer() {
  const routeSearch = useSearch({ from: "/tracks" });
  const navigate = useNavigate({ from: "/tracks" });

  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrack, setSelectedTrack] = useState<TrackInfo | null>(null);
  const [search, setSearch] = useState("");

  const handleSelectTrack = useCallback((t: TrackInfo) => {
    setSelectedTrack(t);
    navigate({ search: { track: t.ordinal }, replace: true });
  }, [navigate]);

  const handleBack = useCallback(() => {
    setSelectedTrack(null);
    navigate({ search: {}, replace: true });
  }, [navigate]);

  useEffect(() => {
    fetch("/api/tracks")
      .then((r) => r.json())
      .then((data: TrackInfo[]) => {
        setTracks(data);
        // If URL has a track param, select it
        if (routeSearch.track) {
          const match = data.find((t) => t.ordinal === routeSearch.track);
          if (match) setSelectedTrack(match);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-4 text-app-text-dim">Loading tracks...</div>;
  }

  if (selectedTrack) {
    return <TrackDetail track={selectedTrack} onBack={handleBack} />;
  }

  const query = search.toLowerCase().trim();
  const filtered = query
    ? tracks.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.variant.toLowerCase().includes(query) ||
          t.location.toLowerCase().includes(query) ||
          t.country.toLowerCase().includes(query),
      )
    : tracks;

  const withOutline = filtered.filter((t) => t.hasOutline);
  const withoutOutline = filtered.filter((t) => !t.hasOutline);

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-xs text-app-text-muted uppercase tracking-wider whitespace-nowrap">
          Available Tracks ({withOutline.length} with outlines, {withoutOutline.length} without)
        </div>
        <input
          type="text"
          placeholder="Search tracks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 w-full max-w-xs rounded-md border border-app-border-input bg-app-surface-alt px-2.5 text-sm text-app-text placeholder:text-app-text-dim outline-none focus:border-app-text-muted transition-colors"
        />
      </div>

      {filtered.length === 0 && (
        <div className="text-sm text-app-text-dim mt-6">No tracks matching &ldquo;{search}&rdquo;</div>
      )}

      {withOutline.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {withOutline.map((t) => (
            <TrackCard key={t.ordinal} track={t} onSelect={handleSelectTrack} />
          ))}
        </div>
      )}

      {withoutOutline.length > 0 && (
        <>
          <div className="text-xs text-app-text-muted uppercase tracking-wider mb-3 mt-4">
            Tracks Without Outlines
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {withoutOutline.map((t) => (
              <div
                key={t.ordinal}
                className="border border-app-border rounded-lg p-3 bg-app-surface/30 cursor-pointer hover:border-app-border-input"
                onClick={() => handleSelectTrack(t)}
              >
                <div className="text-sm text-app-text-secondary">{t.name}</div>
                <div className="text-xs text-app-text-dim">
                  {t.variant} &middot; {t.location}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
