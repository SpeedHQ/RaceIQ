import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { countryName } from "@/lib/country-names";
import { client } from "@/lib/rpc";
import { trackRoutePath } from "@/lib/track-routes";
import { m } from "@/paraglide/messages";
import { useCatalogTunes, useTracks, useUserTunes } from "../hooks/queries";
import { useGameId } from "../stores/game";
import { tuneMatchesTrack } from "./track/CatalogTrackSetups";
import { TrackCard } from "./track/TrackCard";
import type { TrackInfo } from "./track/types";
import { AppInput } from "./ui/AppInput";
import { Button } from "./ui/button";

type SortKey = "name" | "laps";

/** TrackViewer — Gallery view of all known tracks, split into "with maps" and "without". */
export function TrackViewer() {
  const navigate = useNavigate();

  const gameId = useGameId();
  const { data: tracks = [], isLoading: loading } = useTracks() as { data: TrackInfo[]; isLoading: boolean };
  const { data: f125Tracks = [] } = useQuery<{ trackOrdinal: number; setupCount: number; guideCount: number; guideUrl: string }[]>({
    queryKey: ["f125-tracks", gameId],
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as { trackOrdinal: number; setupCount: number; guideCount: number; guideUrl: string }[]),
    enabled: gameId === "f1-2025",
  });
  const f125ByOrdinal = Object.fromEntries(f125Tracks.map((t) => [t.trackOrdinal, t]));

  // Forza + AC-EVO: setup counts derived client-side from the community catalog.
  const isCatalogGame = gameId === "fm-2023" || gameId === "ac-evo";
  const { data: catalog = [] } = useCatalogTunes();
  const { data: userTunes = [] } = useUserTunes(gameId ?? undefined);
  const catalogCounts = useMemo(() => {
    if (!isCatalogGame || !gameId) return {} as Record<number, number>;
    const all = [...catalog, ...(userTunes as { trackOrdinal?: number | null; bestTracks?: string[] }[])];
    const m: Record<number, number> = {};
    for (const t of tracks) {
      const n = all.filter((tune) => tuneMatchesTrack(tune, t)).length;
      if (n > 0) m[t.ordinal] = n;
    }
    return m;
  }, [isCatalogGame, gameId, tracks, catalog, userTunes]);

  // ACC: setup counts from the dedicated per-track endpoint.
  const { data: accCounts = {} } = useQuery<Record<number, number>>({
    queryKey: ["acc-setup-counts"],
    queryFn: () => client.api.acc["setup-counts"].$get().then((r) => r.json() as Promise<Record<number, number>>),
    enabled: gameId === "acc",
  });

  // Supported games always report a count (0 shows a "0 setups/guides" badge);
  // unsupported games return undefined so no badge renders at all.
  const setupCountFor = (ordinal: number): number | undefined => {
    if (gameId === "f1-2025") return f125ByOrdinal[ordinal]?.setupCount ?? 0;
    if (gameId === "acc") return accCounts[ordinal] ?? 0;
    if (isCatalogGame) return catalogCounts[ordinal] ?? 0;
    return undefined;
  };
  const guideCountFor = (ordinal: number): number | undefined => {
    if (gameId === "f1-2025") return f125ByOrdinal[ordinal]?.guideCount ?? 0;
    if (gameId === "acc" || isCatalogGame) return 0;
    return undefined;
  };

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  // Selecting a track is a navigation now — the detail view is its own route.
  const handleSelectTrack = useCallback(
    (t: TrackInfo) => {
      if (!gameId) return;
      navigate({ to: trackRoutePath(gameId, t.ordinal) });
    },
    [navigate, gameId],
  );

  if (loading) {
    return <div className="p-4 text-app-text-dim">{m.trackviewer_loading()}</div>;
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

  const withOutline = sorted.filter((t) => t.hasOutline || t.hasMap);
  const withoutOutline = sorted.filter((t) => !t.hasOutline && !t.hasMap);

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center flex-wrap gap-3 mb-3">
        <AppInput placeholder={m.trackviewer_search_placeholder()} value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 min-w-[180px] sm:flex-none sm:max-w-xs" />
        <div className="flex items-center gap-1.5 md:gap-1 text-sm md:text-app-label text-app-text-muted">
          <span className="uppercase tracking-wider">{m.trackviewer_sort_label()}</span>
          {(["name", "laps"] as SortKey[]).map((key) => (
            <Button
              key={key}
              onClick={() => setSortKey(key)}
              className={`px-3 py-2 md:px-2 md:py-0.5 rounded capitalize ${sortKey === key ? "bg-app-surface-alt border border-app-border text-app-text" : "text-app-text-dim hover:text-app-text-muted"}`}
            >
              {key}
            </Button>
          ))}
        </div>
        <div className="text-app-label text-app-text-muted uppercase tracking-wider whitespace-nowrap">
          {withOutline.length} {m.trackviewer_with_outlines()}, {withoutOutline.length} {m.trackviewer_without_outlines_suffix()}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="text-app-subtext text-app-text-dim mt-6">
          {m.trackviewer_no_tracks_matching()} &ldquo;{search}&rdquo;
        </div>
      )}

      {withOutline.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {withOutline.map((t) => (
            <TrackCard key={t.ordinal} track={t} onSelect={handleSelectTrack} gameId={gameId} setupCount={setupCountFor(t.ordinal)} guideCount={guideCountFor(t.ordinal)} />
          ))}
        </div>
      )}

      {withoutOutline.length > 0 && (
        <>
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-3 mt-4">{m.trackviewer_without_outlines_title()}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {withoutOutline.map((t) => (
              <div key={t.ordinal} className="border border-app-border rounded-lg p-3 bg-app-surface/30 cursor-pointer hover:border-app-border-hover" onClick={() => handleSelectTrack(t)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-app-body text-app-text-secondary">{t.name}</div>
                  <span className="shrink-0 text-app-label px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border text-app-text-muted">
                    {t.lapCount ?? 0} {(t.lapCount ?? 0) === 1 ? m.trackcard_lap_singular() : m.pitwindow_laps()}
                  </span>
                </div>
                <div className="text-app-label text-app-text-dim">
                  {t.variant} · {t.location}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
