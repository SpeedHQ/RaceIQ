import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { client } from "../../lib/rpc";
import { SearchSelect } from "../ui/SearchSelect";
import { SiGoogledrive, SiDropbox, SiMega, SiYoutube } from "react-icons/si";
import { Download, Cloud } from "lucide-react";

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

type LinkPlatform = "youtube" | "google-drive" | "onedrive" | "dropbox" | "mega" | "generic";

function detectPlatform(url: string): LinkPlatform {
  try {
    const h = new URL(url).hostname;
    if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
    if (h.includes("drive.google.com") || h.includes("docs.google.com")) return "google-drive";
    if (h.includes("onedrive.live.com") || h.includes("1drv.ms") || h.includes("sharepoint.com")) return "onedrive";
    if (h.includes("dropbox.com")) return "dropbox";
    if (h.includes("mega.nz") || h.includes("mega.co.nz")) return "mega";
  } catch {}
  return "generic";
}

function PlatformIcon({ platform, className = "w-3.5 h-3.5" }: { platform: LinkPlatform; className?: string }) {
  if (platform === "youtube") return <SiYoutube className={className} />;
  if (platform === "google-drive") return <SiGoogledrive className={className} />;
  if (platform === "onedrive") return <Cloud className={className} />;
  if (platform === "dropbox") return <SiDropbox className={className} />;
  if (platform === "mega") return <SiMega className={className} />;
  return <Download className={className} />;
}

const PLATFORM_LABEL: Record<LinkPlatform, string> = {
  youtube: "YouTube",
  "google-drive": "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  mega: "MEGA",
  generic: "Download",
};

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
      <div className="rounded-lg overflow-hidden border border-app-border/20">
        <iframe
          src={`https://www.youtube.com/embed/${vid}`}
          title="Hotlap"
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
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
    <div className="flex gap-3 h-full overflow-hidden">
      {/* Left: filters + setup list */}
      <div className="w-[420px] shrink-0 flex flex-col min-h-0">
        {/* Filters */}
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider shrink-0">Setups ({filteredSetups.length})</div>
          {uniqueCars.length > 1 && (
            <SearchSelect
              className="ml-auto w-48"
              value={filterCar}
              onChange={(v) => {
                setFilterCar(v);
                selectSetup(0);
              }}
              placeholder="Search cars..."
              options={[{ value: "", label: "All cars" }, ...uniqueCars.map((car) => ({ value: car, label: carNameMap.get(car) ?? car }))]}
            />
          )}
        </div>

        {/* Setup list */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20">
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt/50 border-b border-app-border/20 sticky top-0">
            <span className="text-[9px] text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-[9px] text-app-text-dim uppercase flex-1">Author / Car</span>
            <span className="text-[9px] text-app-text-dim uppercase text-center">Type</span>
            <span className="text-[9px] text-app-text-dim uppercase w-16 text-right">Time</span>
          </div>
          {filteredSetups.map((s, i) => (
            <div
              key={setupId(s)}
              onClick={() => selectSetup(i)}
              className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                selectedIdx === i ? "bg-app-accent/10" : "hover:bg-app-surface-alt/30"
              }`}
            >
              <span className="text-app-unit text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-unit font-medium text-app-text truncate">{s.author || "Unknown"}</span>
                <span className="text-[9px] text-app-text-dim truncate">({carNameMap.get(s.carModel) ?? s.carModel})</span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0 justify-center">
                {s.hasRace && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold" title="Race setup">
                    R
                  </span>
                )}
                {s.hasQuali && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold" title="Qualifying setup">
                    Q
                  </span>
                )}
                {s.hasWet && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold" title="Wet setup">
                    W
                  </span>
                )}
                {s.videoUrl && (
                  <span className="text-[9px] text-red-400 ml-0.5" title="Has hotlap video">
                    ▶
                  </span>
                )}
                {(s.downloadUrl || s.setupFile) && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-green-500/20 text-green-300 font-bold" title="Has setup file">
                    FILE
                  </span>
                )}
              </div>
              <span className="text-app-unit font-mono text-emerald-400 shrink-0 w-16 text-right">{s.lapTime || "—"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: setup detail + video */}
      {setup && (
        <div className="flex-1 min-w-0 flex gap-3 h-full overflow-hidden">
          {/* Detail column */}
          <div className="flex-1 min-w-0 overflow-y-auto space-y-3">
            {/* Header */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-app-body font-bold text-app-text">{setup.author || "Unknown"}</span>
              <span className="text-app-unit text-app-text-secondary">
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
                {setup.hasRace && <span className="text-[10px] px-2 py-0.5 rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-300 font-medium">Race</span>}
                {setup.hasQuali && <span className="text-[10px] px-2 py-0.5 rounded-full border border-purple-500/40 bg-purple-500/10 text-purple-300 font-medium">Qualify</span>}
                {setup.hasSafe && <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 font-medium">Safe</span>}
                {setup.hasWet && <span className="text-[10px] px-2 py-0.5 rounded-full border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 font-medium">Wet</span>}
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
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-app-unit font-semibold rounded transition-colors ${isVideo ? "bg-red-500/15 text-red-400 hover:bg-red-500/25" : "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25"}`}
                  >
                    <PlatformIcon platform={platform} />
                    {PLATFORM_LABEL[platform]}
                  </a>
                );
              })()}
              {setup.setupFile && (
                <button
                  onClick={() => installMutation.mutate(setup)}
                  disabled={installMutation.isPending}
                  className="px-3 py-1.5 text-app-unit font-semibold bg-emerald-500/15 text-emerald-400 rounded hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
                >
                  {installMutation.isPending ? "Installing..." : installMutation.isSuccess ? "Installed" : "Install to ACC"}
                </button>
              )}
              {setup.videoUrl && setup.videoUrl !== setup.downloadUrl && (
                <a
                  href={setup.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-app-unit font-semibold bg-red-500/15 text-red-400 rounded hover:bg-red-500/25 transition-colors"
                >
                  <PlatformIcon platform="youtube" />
                  Hotlap
                </a>
              )}
              {setup.pageUrl && (
                <a
                  href={setup.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-app-unit font-semibold bg-app-surface-alt text-app-text-secondary rounded hover:text-app-text transition-colors border border-app-border"
                >
                  accsetups.com
                </a>
              )}
            </div>
          </div>

          {/* Video column */}
          <div className="w-1/2 shrink-0 overflow-hidden">{setup.videoUrl && <SetupVideo url={setup.videoUrl} />}</div>
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
      <div className="w-full max-w-4xl rounded-lg overflow-hidden border border-app-border/20">
        <iframe
          src={embedUrl}
          title={`${trackName} Track Guide`}
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}
