import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { detectPlatform, PLATFORM_LABEL, PlatformIcon } from "@/components/acc/acc-links";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SearchSelect } from "../ui/SearchSelect";

interface AccSetup {
  name: string;
  carModel: string;
  carClass?: string;
  trackName: string;
  driveUrl?: string;
  downloadUrl?: string;
  videoUrl?: string;
  pageUrl?: string;
  notes?: string;
  author?: string;
  lapTime?: string;
  date?: string;
  setupFile?: string;
  hasRace?: boolean;
  hasQuali?: boolean;
  hasSafe?: boolean;
  hasWet?: boolean;
  source?: string;
}

interface AccCar {
  id: number;
  model: string;
  name: string;
  class: string;
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch {}
  return null;
}

function setupId(s: AccSetup): string {
  return btoa(`${s.carModel}|${s.author ?? ""}|${s.lapTime ?? ""}`).replace(/=+$/, "");
}

function SetupVideo({ url }: { url: string }) {
  try {
    const u = new URL(url);
    const vid = u.hostname.includes("youtube.com") ? u.searchParams.get("v") : u.hostname === "youtu.be" ? u.pathname.slice(1) : null;
    if (!vid) return null;
    return (
      <Card className="rounded-lg border-0 bg-transparent p-0 ring-app-border/20">
        <iframe
          src={`https://www.youtube.com/embed/${vid}`}
          title="Hotlap"
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </Card>
    );
  } catch {
    return null;
  }
}

export function AccTrackSetups({ trackOrdinal }: { trackOrdinal: number }) {
  const search = useSearch({ strict: false }) as { setup?: string };
  const navigate = useNavigate();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterCar, setFilterCar] = useState("");

  const { data: setups = [] } = useQuery<AccSetup[]>({
    queryKey: ["acc-setups-by-track", trackOrdinal],
    queryFn: () => client.api.acc["setups-by-track"].$get({ query: { ordinal: String(trackOrdinal) } }).then((r) => r.json() as any),
  });

  const { data: cars = [] } = useQuery<AccCar[]>({
    queryKey: ["acc-cars"],
    queryFn: () => client.api.acc.cars.$get().then((r) => r.json()),
  });

  const carNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const car of cars) map.set(car.model, car.name);
    return map;
  }, [cars]);

  const filteredSetups = useMemo(() => {
    let s = setups;
    if (filterCar) s = s.filter((x) => x.carModel === filterCar);
    return [...s].sort((a, b) => {
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
  }, [setups, filterCar]);

  const uniqueCars = useMemo(() => [...new Set(setups.map((s) => s.carModel))].sort(), [setups]);

  // Resolve setup from URL param
  useEffect(() => {
    if (!search.setup || filteredSetups.length === 0) return;
    const idx = filteredSetups.findIndex((s) => setupId(s) === search.setup);
    if (idx >= 0 && idx !== selectedIdx) setSelectedIdx(idx);
  }, [search.setup, filteredSetups]);

  const selectSetup = (i: number) => {
    setSelectedIdx(i);
    const s = filteredSetups[i];
    if (s) navigate({ search: ((prev: any) => ({ ...prev, setup: setupId(s) })) as any, replace: true });
  };

  const installMutation = useMutation({
    mutationFn: (s: AccSetup) => client.api.acc.setups.install.$post({ json: { carModel: s.carModel, trackName: s.trackName, setupFile: s.setupFile! } }).then((r) => r.json() as any),
  });

  // Fetch YouTube metadata for the selected setup (cached server-side)
  const selectedSetup = filteredSetups[selectedIdx] ?? filteredSetups[0];
  const ytVideoId = useMemo(() => {
    const url = selectedSetup?.downloadUrl || selectedSetup?.videoUrl || "";
    return extractYouTubeId(url);
  }, [selectedSetup]);

  const { data: ytMeta } = useQuery({
    queryKey: ["yt-meta", ytVideoId],
    queryFn: async () => {
      const cacheKey = `yt-meta:${ytVideoId}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached) as { uploadDate: string; downloadUrl: string };
      const res = await fetch(`/api/acc/yt-meta?videoId=${ytVideoId}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { uploadDate: string; downloadUrl: string };
      localStorage.setItem(cacheKey, JSON.stringify(data));
      return data;
    },
    enabled: !!ytVideoId,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Merge YouTube metadata into the selected setup
  const setup: AccSetup | undefined = selectedSetup
    ? {
        ...selectedSetup,
        date: ytMeta?.uploadDate || selectedSetup.date,
        downloadUrl: ytMeta?.downloadUrl || selectedSetup.downloadUrl,
      }
    : undefined;

  return (
    <div className="flex h-auto flex-col gap-3 overflow-visible @3xl/workspace:h-full @3xl/workspace:flex-row @3xl/workspace:overflow-hidden">
      {/* Left: filters + setup list */}
      <div className="flex min-h-0 w-full shrink-0 flex-col @3xl/workspace:w-[420px]">
        {/* Filters */}
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider shrink-0">Setups ({filteredSetups.length})</div>
          {uniqueCars.length > 1 && (
            <SearchSelect
              className="w-full @3xl/workspace:ml-auto @3xl/workspace:w-48"
              value={filterCar}
              onChange={(v) => {
                setFilterCar(v);
                selectSetup(0);
              }}
              placeholder={m.catalog_search_cars_placeholder()}
              options={[{ value: "", label: m.catalog_filter_all_cars() }, ...uniqueCars.map((car) => ({ value: car, label: carNameMap.get(car) ?? car }))]}
            />
          )}
        </div>

        {/* Setup list */}
        <Card className="flex-1 min-h-0 overflow-y-auto rounded-lg border-0 bg-transparent p-0 ring-app-border/20">
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt/50 border-b border-app-border/20 sticky top-0">
            <span className="text-app-micro text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-app-micro text-app-text-dim uppercase flex-1">{m.label_author_car()}</span>
            <span className="text-app-micro text-app-text-dim uppercase text-center">{m.label_type()}</span>
            <span className="text-app-micro text-app-text-dim uppercase w-16 text-right">{m.label_time()}</span>
          </div>
          {filteredSetups.map((s, i) => (
            <button
              type="button"
              key={setupId(s)}
              onClick={() => selectSetup(i)}
              className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left cursor-pointer border-b border-app-border/10 transition-colors ${
                selectedIdx === i ? "bg-app-accent/10" : "hover:bg-app-surface-hover/30"
              }`}
            >
              <span className="text-app-compact text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <span className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-compact font-medium text-app-text truncate">{s.author || "Unknown"}</span>
                <span className="text-app-micro text-app-text-dim truncate">({carNameMap.get(s.carModel) ?? s.carModel})</span>
              </span>
              <span className="flex items-center gap-0.5 shrink-0 justify-center">
                {s.hasRace && (
                  <span className="setup-variant-badge text-app-nano px-1 py-0.5 rounded font-bold" data-setup-variant="race" title={m.accsetup_setup_type_race_title()}>
                    R
                  </span>
                )}
                {s.hasQuali && (
                  <span className="setup-variant-badge text-app-nano px-1 py-0.5 rounded font-bold" data-setup-variant="qualifying" title={m.accsetup_setup_type_qualifying_title()}>
                    Q
                  </span>
                )}
                {s.hasWet && (
                  <span className="setup-variant-badge text-app-nano px-1 py-0.5 rounded font-bold" data-setup-variant="wet" title={m.accsetup_setup_type_wet_title()}>
                    W
                  </span>
                )}
                {s.videoUrl && (
                  <span className="text-app-micro ml-0.5" style={{ color: "var(--brand-provider-youtube)" }} title={m.accsetup_setup_type_has_video_title()}>
                    ▶
                  </span>
                )}
                {(s.downloadUrl || s.setupFile) && (
                  <span className="setup-variant-badge text-app-nano px-1 py-0.5 rounded font-bold" data-setup-variant="file" title={m.accsetup_setup_type_has_file_title()}>
                    {m.accsetup_file()}
                  </span>
                )}
              </span>
              <span className="text-app-compact font-mono text-(--lap-pace-on-target) shrink-0 w-16 text-right">{s.lapTime || "—"}</span>
            </button>
          ))}
        </Card>
      </div>

      {/* Right: setup detail + video */}
      {setup && (
        <div className="flex h-auto min-w-0 flex-1 flex-col gap-3 overflow-visible @5xl/workspace:h-full @5xl/workspace:flex-row @5xl/workspace:overflow-hidden">
          {/* Detail column */}
          <div className="flex-1 min-w-0 overflow-y-auto space-y-3">
            {/* Header */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-app-body font-bold text-app-text">{setup.author || "Unknown"}</span>
              <span className="text-app-compact text-app-text-secondary">
                {carNameMap.get(setup.carModel) ?? setup.carModel}
                {setup.lapTime && ` · ${setup.lapTime}`}
                {setup.date && ` · ${setup.date}`}
              </span>
            </div>

            {/* Name & notes */}
            <div>
              <div className="text-sm text-app-text">{setup.name}</div>
              {setup.notes && <p className="text-xs text-app-text-dim mt-1">{setup.notes}</p>}
            </div>

            {/* Variant tags */}
            {(setup.hasRace || setup.hasQuali || setup.hasSafe || setup.hasWet) && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {setup.hasRace && (
                  <span className="setup-variant-badge text-app-caption px-2 py-0.5 rounded-full border font-medium" data-setup-variant="race">
                    {m.label_race()}
                  </span>
                )}
                {setup.hasQuali && (
                  <span className="setup-variant-badge text-app-caption px-2 py-0.5 rounded-full border font-medium" data-setup-variant="qualifying">
                    {m.accsetup_badge_qualify()}
                  </span>
                )}
                {setup.hasSafe && (
                  <span className="setup-variant-badge text-app-caption px-2 py-0.5 rounded-full border font-medium" data-setup-variant="safe">
                    {m.accsetup_badge_safe()}
                  </span>
                )}
                {setup.hasWet && (
                  <span className="setup-variant-badge text-app-caption px-2 py-0.5 rounded-full border font-medium" data-setup-variant="wet">
                    {m.accsetup_badge_wet()}
                  </span>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                const dlUrl = setup.downloadUrl || setup.driveUrl;
                if (!dlUrl) return null;
                const platform = detectPlatform(dlUrl);
                const isVideo = platform === "youtube";
                return (
                  <a
                    href={dlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-app-compact font-semibold rounded transition-colors ${isVideo ? "provider-badge hover:opacity-80" : "bg-app-accent/15 text-app-accent hover:bg-app-accent/25"}`}
                    data-provider-brand={isVideo ? "youtube" : undefined}
                  >
                    <PlatformIcon platform={platform} />
                    {PLATFORM_LABEL[platform]}
                  </a>
                );
              })()}
              {setup.setupFile && (
                <Button
                  onClick={() => installMutation.mutate(setup)}
                  disabled={installMutation.isPending}
                  className="px-3 py-1.5 text-app-compact font-semibold bg-status-success/15 text-status-success rounded hover:bg-status-success/25 transition-colors disabled:opacity-50"
                >
                  {installMutation.isPending ? "Installing..." : installMutation.isSuccess ? "Installed" : "Install to ACC"}
                </Button>
              )}
              {setup.videoUrl && setup.videoUrl !== setup.downloadUrl && (
                <a
                  href={setup.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="provider-badge flex items-center gap-1.5 px-3 py-1.5 text-app-compact font-semibold rounded hover:opacity-80 transition-colors"
                  data-provider-brand="youtube"
                >
                  <PlatformIcon platform="youtube" />
                  {m.label_hotlap()}
                </a>
              )}
              {setup.pageUrl && (
                <a
                  href={setup.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-app-compact font-semibold bg-app-surface-alt text-app-text-secondary rounded hover:text-app-text transition-colors border border-app-border"
                >
                  accsetups.com
                </a>
              )}
            </div>
          </div>

          {/* Video column */}
          <div className="w-full shrink-0 overflow-hidden @5xl/workspace:w-1/2">{setup.videoUrl && <SetupVideo url={setup.videoUrl} />}</div>
        </div>
      )}
    </div>
  );
}

/* ── Track guide videos by ordinal ── */

const ACC_GUIDE_VIDEOS: Record<number, string> = {
  6: "https://www.youtube.com/embed/8eNe6VacNbQ", // Spa-Francorchamps
};

export function AccTrackGuide({ trackOrdinal, trackName }: { trackOrdinal: number; trackName: string }) {
  const embedUrl = ACC_GUIDE_VIDEOS[trackOrdinal];

  if (!embedUrl) {
    return <div className="text-app-text-dim text-sm py-4 text-center">No track guide available for {trackName}</div>;
  }

  return (
    <div className="flex items-start justify-center h-full p-4">
      <Card className="w-full max-w-4xl rounded-lg border-0 bg-transparent p-0 ring-app-border/20">
        <iframe
          src={embedUrl}
          title={`${trackName} Track Guide`}
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </Card>
    </div>
  );
}
