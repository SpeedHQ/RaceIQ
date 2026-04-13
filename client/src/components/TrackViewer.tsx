import { useEffect, useState, useCallback } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { useTracks } from "../hooks/queries";
import { useGameId } from "../stores/game";
import { AppInput } from "./ui/AppInput";
import { countryName } from "@/lib/country-names";
import { TrackCard } from "./track/TrackCard";
import { TrackDetail } from "./track/TrackDetail";
import type { TrackInfo } from "./track/types";

type SortKey = "name" | "laps";

/** TrackViewer — Gallery view of all known tracks, split into "with outlines" and "without". */
export function TrackViewer() {
  const routeSearch = useSearch({ strict: false }) as { track?: number; tab?: string };
  const navigate = useNavigate();

  const gameId = useGameId();
  const { data: tracks = [], isLoading: loading } = useTracks() as { data: TrackInfo[]; isLoading: boolean };
  const [selectedTrack, setSelectedTrack] = useState<TrackInfo | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const handleSelectTrack = useCallback((t: TrackInfo) => {
    setSelectedTrack(t);
    navigate({ search: { track: t.ordinal } as never, replace: true });
  }, [navigate]);

  const handleBack = useCallback(() => {
    setSelectedTrack(null);
    navigate({ search: {} as never, replace: true });
  }, [navigate]);

  // If URL has a track param, select it once tracks load
  useEffect(() => {
    if (tracks.length > 0 && routeSearch.track && !selectedTrack) {
      const match = tracks.find((t) => t.ordinal === routeSearch.track);
      if (match) setSelectedTrack(match);
    }
  }, [tracks, routeSearch.track]);

  if (loading) {
    return <div className="p-4 text-app-text-dim">Loading tracks...</div>;
  }

  if (selectedTrack) {
    return <TrackDetail track={selectedTrack} onBack={handleBack} initialTab={routeSearch.tab} navigate={navigate} />;
  }

  const query = search.toLowerCase().trim();
  const filtered = query
    ? tracks.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.variant.toLowerCase().includes(query) ||
          t.location.toLowerCase().includes(query) ||
          t.country.toLowerCase().includes(query) ||
          countryName(t.country).toLowerCase().includes(query),
      )
    : tracks;

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "laps") return (b.lapCount ?? 0) - (a.lapCount ?? 0);
    return a.name.localeCompare(b.name);
  });

  const withOutline = sorted.filter((t) => t.hasOutline);
  const withoutOutline = sorted.filter((t) => !t.hasOutline);

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center gap-3 mb-3">
        <AppInput
          placeholder="Search tracks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs"
        />
        <div className="flex items-center gap-1 text-app-label text-app-text-muted">
          <span className="uppercase tracking-wider">Sort:</span>
          {(["name", "laps"] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setSortKey(key)}
              className={`px-2 py-0.5 rounded capitalize ${sortKey === key ? "bg-app-surface-alt border border-app-border text-app-text" : "text-app-text-dim hover:text-app-text-muted"}`}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="text-app-label text-app-text-muted uppercase tracking-wider whitespace-nowrap">
          {withOutline.length} with outlines, {withoutOutline.length} without
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="text-app-subtext text-app-text-dim mt-6">No tracks matching &ldquo;{search}&rdquo;</div>
      )}

      {withOutline.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {withOutline.map((t) => (
            <TrackCard key={t.ordinal} track={t} onSelect={handleSelectTrack} gameId={gameId} />
          ))}
        </div>
      )}

      {withoutOutline.length > 0 && (
        <>
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-3 mt-4">
            Tracks Without Outlines
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {withoutOutline.map((t) => (
              <div
                key={t.ordinal}
                className="border border-app-border rounded-lg p-3 bg-app-surface/30 cursor-pointer hover:border-app-border-input"
                onClick={() => handleSelectTrack(t)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-app-body text-app-text-secondary">{t.name}</div>
                  <span className="shrink-0 text-app-label px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border text-app-text-muted">
                    {t.lapCount ?? 0} {(t.lapCount ?? 0) === 1 ? "lap" : "laps"}
                  </span>
                </div>
                <div className="text-app-label text-app-text-dim">{t.variant} · {t.location}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
