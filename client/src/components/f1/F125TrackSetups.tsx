import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { client } from "@/lib/rpc";

function setupId(s: { author: string; provider: string; lapTime: string }): string {
  return btoa(`${s.provider}|${s.author}|${s.lapTime}`).replace(/=+$/, "");
}

interface F125Setup {
  team: string;
  author: string;
  lapTime: string;
  sessionType: string;
  inputDevice: string;
  weather: string;
  source: string;
  provider: string;
  videoUrl?: string;
  setup: Record<string, number | null>;
}

interface F125GuideSection {
  heading: string;
  body: string;
}

interface F125GuideEntry {
  source: string;
  videoUrl: string;
  sections: F125GuideSection[];
  setupTips: string;
  drivingTips: string;
}

interface F125TrackData {
  trackSlug: string;
  trackName: string;
  trackOrdinal: number;
  trackGuide?: F125GuideEntry[];
  setups: F125Setup[];
}

interface F125TrackSummary {
  trackSlug: string;
  trackName: string;
  trackOrdinal: number;
  setupCount: number;
}

const SETUP_GROUPS: { title: string; fields: [string, string, string?][] }[] = [
  { title: "Aero", fields: [["frontWing", "Front Wing"], ["rearWing", "Rear Wing"]] },
  { title: "Transmission", fields: [["diffOnThrottle", "On Throttle", "%"], ["diffOffThrottle", "Off Throttle", "%"]] },
  { title: "Geometry", fields: [["frontCamber", "F Camber", "°"], ["rearCamber", "R Camber", "°"], ["frontToe", "F Toe", "°"], ["rearToe", "R Toe", "°"]] },
  { title: "Suspension", fields: [["frontSuspension", "F Susp"], ["rearSuspension", "R Susp"], ["frontAntiRollBar", "F ARB"], ["rearAntiRollBar", "R ARB"], ["frontRideHeight", "F Height"], ["rearRideHeight", "R Height"]] },
  { title: "Brakes", fields: [["brakePressure", "Pressure"], ["frontBrakeBias", "Bias"]] },
  { title: "Tires", fields: [["frontLeftTyrePressure", "FL", " psi"], ["frontRightTyrePressure", "FR", " psi"], ["rearLeftTyrePressure", "RL", " psi"], ["rearRightTyrePressure", "RR", " psi"]] },
];

function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "f1laps") return <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-blue-500/20 text-blue-400 shrink-0">F1L</span>;
  if (provider === "simracingsetup") return <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-red-500/20 text-red-400 shrink-0">SRS</span>;
  return null;
}

function getYouTubeVid(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch { /* invalid URL */ }
  return null;
}

function SetupVideo({ url }: { url: string }) {
  const vid = getYouTubeVid(url);
  if (!vid) return null;
  return (
    <div className="rounded-lg overflow-hidden border border-app-border/20">
      <iframe src={`https://www.youtube.com/embed/${vid}`} title="Hotlap" className="w-full aspect-video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
    </div>
  );
}

export function F125SetupsWithGuide({ trackOrdinal, trackName }: { trackOrdinal: number; trackName: string }) {
  const search = useSearch({ strict: false }) as { subtab?: string };
  const navigate = useNavigate();
  const validSubTabs = ["setups", "ranges"] as const;
  type SubTab = typeof validSubTabs[number];
  const subTab: SubTab = (validSubTabs as readonly string[]).includes(search.subtab ?? "") ? (search.subtab as SubTab) : "setups";
  const setSubTab = (tab: SubTab) => {
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, subtab: tab === "setups" ? undefined : tab }) as never, replace: true });
  };

  const tabLabels = { setups: "Setups", ranges: "Compare" } as const;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex gap-1 shrink-0">
        {(["setups", "ranges"] as const).map(tab => (
          <button key={tab} onClick={() => setSubTab(tab)}
            className={`text-app-unit px-3 py-1 rounded border transition-colors ${
              subTab === tab ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"
            }`}>
            {tabLabels[tab]}
          </button>
        ))}
      </div>
      {subTab === "setups" ? (
        <F125TrackSetups trackOrdinal={trackOrdinal} trackName={trackName} />
      ) : (
        <F125SetupRanges trackOrdinal={trackOrdinal} />
      )}
    </div>
  );
}

function sourceDisplayName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
    if (u.hostname === "youtu.be") return `https://www.youtube.com/embed${u.pathname}`;
  } catch {}
  return url;
}

export function F125TrackGuide({ trackOrdinal }: { trackOrdinal: number }) {
  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then(r => r.json() as unknown as F125TrackSummary[]),
  });
  const trackSlug = tracks.find(t => t.trackOrdinal === trackOrdinal)?.trackSlug;
  const { data: trackData } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then(r => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  const guides = trackData?.trackGuide ?? [];
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<"guide" | "setup">("guide");
  const activeGuide = guides.find(g => g.source === selectedSource) ?? guides[0];

  if (guides.length === 0) return (
    <div className="text-app-text-secondary text-app-unit p-4">No guide available for this track.</div>
  );

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Source list */}
      <div className="w-56 shrink-0 flex flex-col gap-1">
        {guides.map(g => {
          const isActive = g.source === activeGuide?.source;
          const sectionCount = g.sections?.length ?? 0;
          return (
            <button key={g.source} onClick={() => setSelectedSource(g.source)}
              className={`text-left px-2 py-2 rounded border transition-colors ${
                isActive ? "border-app-accent/40 bg-app-accent/10" : "border-app-border hover:border-app-border-hover bg-app-surface-alt/30 hover:bg-app-surface-alt"
              }`}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-sm font-medium ${isActive ? "text-app-accent" : "text-app-text"}`}>
                  {sourceDisplayName(g.source)}
                </span>
                {sectionCount > 0 && (
                  <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-blue-500/20 text-blue-400">Text</span>
                )}
                {g.videoUrl && (
                  <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-red-500/20 text-red-400">YT</span>
                )}
              </div>
              <table className="w-full text-xs text-app-text-secondary">
                <tbody>
                  {g.setupTips && (
                    <tr>
                      <td className="pr-2 text-app-text-dim">Setup tips</td>
                      <td>Yes</td>
                    </tr>
                  )}
                  {g.drivingTips && (
                    <tr>
                      <td className="pr-2 text-app-text-dim">Driving tips</td>
                      <td>Yes</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </button>
          );
        })}
      </div>

      {/* Guide content */}
      {activeGuide && (
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {/* Content tabs + source link */}
          <div className="flex items-center gap-2 mb-2 shrink-0">
            <button onClick={() => setContentTab("guide")}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${contentTab === "guide" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}>
              Guide
            </button>
            {activeGuide.setupTips && (
              <button onClick={() => setContentTab("setup")}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${contentTab === "setup" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}>
                Setup Tips
              </button>
            )}
            {activeGuide.source && (
              <a href={activeGuide.source} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-app-text-muted hover:text-app-text underline underline-offset-2">
                View on {sourceDisplayName(activeGuide.source)} ↗
              </a>
            )}
          </div>
          <div className="overflow-y-auto rounded-lg border border-app-border/15 bg-app-surface-alt/15 p-3 flex-1">
            {contentTab === "guide" && (
              <>
                {activeGuide.videoUrl && (
                  <div className="float-right ml-4 mb-4 rounded-lg overflow-hidden border border-app-border/30" style={{ width: "45%" }}>
                    <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                      <iframe src={toEmbedUrl(activeGuide.videoUrl)} title="Track Guide" className="absolute inset-0 w-full h-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                    </div>
                  </div>
                )}
                {activeGuide.sections?.map((s, i) => (
                  <div key={i} className="mb-6">
                    {s.heading && <p className="text-app-text font-semibold text-sm mb-1">{s.heading}</p>}
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{s.body}</p>
                  </div>
                ))}
              </>
            )}
            {contentTab === "setup" && (
              <>
                {activeGuide.setupTips && (
                  <div className="mb-4">
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{activeGuide.setupTips}</p>
                  </div>
                )}
                {activeGuide.drivingTips && (
                  <div className="mb-6">
                    <p className="text-app-text font-semibold text-sm mb-1">Driving Tips</p>
                    <p className="text-app-text-secondary text-sm leading-relaxed whitespace-pre-line">{activeGuide.drivingTips}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function F125TrackSetups({ trackOrdinal }: { trackOrdinal: number; trackName?: string }) {
  const search = useSearch({ strict: false }) as { setup?: string };
  const navigate = useNavigate();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterProvider, setFilterProvider] = useState<"" | "f1laps" | "simracingsetup">("");
  const [filterWeather, setFilterWeather] = useState<"" | "Dry" | "Wet">("");

  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then(r => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find(t => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData, isLoading } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then(r => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const filteredSetups = useMemo(() => {
    if (!trackData?.setups) return [];
    let s = trackData.setups;
    if (filterProvider) s = s.filter(x => (x.provider || "f1laps") === filterProvider);
    if (filterWeather) s = s.filter(x => x.weather === filterWeather);
    return [...s].sort((a, b) => {
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
  }, [trackData?.setups, filterProvider, filterWeather]);

  // Resolve setup from URL param
  useEffect(() => {
    if (!search.setup || filteredSetups.length === 0) return;
    const idx = filteredSetups.findIndex(s => setupId(s) === search.setup);
    if (idx >= 0 && idx !== selectedIdx) setSelectedIdx(idx);
  }, [search.setup, filteredSetups]);

  const selectSetup = (i: number) => {
    setSelectedIdx(i);
    const s = filteredSetups[i];
    if (s) navigate({ search: ((prev: any) => ({ ...prev, setup: setupId(s) })) as any, replace: true });
  };

  if (!trackSlug) return <div className="text-app-text-dim text-sm py-4 text-center">No community setups available for this track</div>;
  if (isLoading || !trackData) return <div className="text-app-text-dim text-sm py-4 text-center animate-pulse">Loading setups...</div>;
  if (!trackData.setups?.length) return <div className="text-app-text-dim text-sm py-4 text-center">No community setups available</div>;

  const setup = filteredSetups[selectedIdx] ?? filteredSetups[0];
  const f1lapsCount = trackData.setups.filter(s => (s.provider || "f1laps") === "f1laps").length;
  const srsCount = trackData.setups.filter(s => s.provider === "simracingsetup").length;
  const wetCount = trackData.setups.filter(s => s.weather === "Wet").length;
  const dryCount = trackData.setups.filter(s => s.weather !== "Wet").length;

  return (
    <div className="flex gap-3 h-full overflow-hidden">
      {/* Left: filters + setup list */}
      <div className="w-[420px] shrink-0 flex flex-col min-h-0">
        {/* Filters — single row */}
        <div className="flex items-center gap-1 mb-1.5">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider shrink-0">
            Setups ({filteredSetups.length})
          </div>
          <div className="flex gap-0.5 ml-auto">
            {(["", "f1laps", "simracingsetup"] as const).map(p => (
              <button key={p} onClick={() => { setFilterProvider(p); selectSetup(0); }}
                className={`text-app-unit px-2 py-1 rounded border transition-colors ${filterProvider === p ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}>
                {p === "" ? "All" : p === "f1laps" ? `F1Laps (${f1lapsCount})` : `SRS (${srsCount})`}
              </button>
            ))}
          </div>
          <span className="text-app-border mx-0.5">|</span>
          <div className="flex gap-0.5">
            {(["Dry", "Wet"] as const).map(w => (
              <button key={w} onClick={() => { setFilterWeather(filterWeather === w ? "" : w); selectSetup(0); }}
                className={`text-app-unit px-2 py-1 rounded border transition-colors ${filterWeather === w ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}>
                {w === "Dry" ? `☀ ${dryCount}` : `🌧 ${wetCount}`}
              </button>
            ))}
          </div>
        </div>

        {/* Setup list */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20">
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt border-b border-app-border/20 sticky top-0 z-10">
            <span className="text-[9px] text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-[9px] text-app-text-dim uppercase w-7 shrink-0">Src</span>
            <span className="text-[9px] text-app-text-dim uppercase flex-1">Author / Team</span>
            <span className="text-[9px] text-app-text-dim uppercase w-8 text-center">Input</span>
            <span className="text-[9px] text-app-text-dim uppercase w-12 text-center">Info</span>
            <span className="text-[9px] text-app-text-dim uppercase w-16 text-right">Time</span>
          </div>
          {filteredSetups.map((s, i) => (
            <div
              key={i}
              onClick={() => selectSetup(i)}
              className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                selectedIdx === i ? "bg-app-accent/10" : "hover:bg-app-surface-alt/30"
              }`}
            >
              <span className="text-app-unit text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <ProviderBadge provider={s.provider} />
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-unit font-medium text-app-text truncate">{s.author || "—"}</span>
                {s.team && <span className="text-[9px] text-app-text-dim truncate">({s.team})</span>}
              </div>
              <div className="shrink-0 w-8 text-center">
                {s.inputDevice === "wheel" && <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">WHL</span>}
                {s.inputDevice === "controller" && <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/20 text-orange-300 font-bold">PAD</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0 w-12 justify-center">
                {s.videoUrl && <span className="text-[9px] text-red-400" title="Has hotlap video">▶</span>}
                {s.weather === "Wet" && <span className="text-[8px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">WET</span>}
              </div>
              <span className="text-app-unit font-mono text-emerald-400 shrink-0 w-16 text-right">{s.lapTime || "—"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: setup detail (2/3) + video (1/3) */}
      {setup && (
        <div className="flex-1 min-w-0 flex gap-3 h-full overflow-hidden">
          {/* Setup detail column */}
          <div className="flex-1 min-w-0 overflow-y-auto space-y-2">
            {/* Header */}
            <div className="flex items-center gap-2 flex-wrap">
              <ProviderBadge provider={setup.provider} />
              <span className="text-app-body font-bold text-app-text">{setup.author || "Unknown"}</span>
              <span className="text-app-unit text-app-text-secondary">
                {setup.team && `${setup.team} · `}{setup.lapTime}
                {setup.inputDevice && ` · ${setup.inputDevice === "wheel" ? "Wheel" : "Controller"}`}
                {setup.weather === "Wet" && " · Wet"}
                {setup.sessionType && ` · ${setup.sessionType}`}
              </span>
              {setup.source && (
                <a href={setup.source} target="_blank" rel="noopener noreferrer"
                  className="px-2 py-1 text-app-unit bg-blue-500/15 text-blue-400 rounded hover:bg-blue-500/25 transition-colors">
                  View Source
                </a>
              )}
            </div>

            {/* Setup values */}
            <div className="grid grid-cols-2 gap-x-6 content-start">
              {SETUP_GROUPS.map((group) => (
                <div key={group.title}>
                  <div className="text-xs text-app-accent uppercase tracking-wider font-bold mt-2 mb-1 border-b border-app-border/20 pb-0.5">{group.title}</div>
                  {group.fields.map(([key, label, unit]) => {
                    const val = setup.setup[key];
                    return (
                      <div key={key} className="flex justify-between py-0.5">
                        <span className="text-app-label font-semibold text-app-text">{label}</span>
                        <span className="text-app-label font-mono font-medium text-app-text">{val != null ? `${val}${unit ?? ""}` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Video column */}
          <div className="w-1/2 shrink-0 overflow-hidden">
            {setup.videoUrl && <SetupVideo url={setup.videoUrl} />}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Range bar visual: min/max track with median marker ── */

function SetupRangeBar({ min, max, median, values, selected, unit }: { min: number; max: number; median: number; values: number[]; selected?: number | null; unit?: string }) {
  const spread = max - min;
  if (spread === 0) {
    return (
      <div className="relative h-5 mt-1 mb-0.5">
        <div className="absolute inset-x-0 top-2 h-[3px] bg-app-border-input/25 rounded-full" />
        <div className="absolute top-[5px] -translate-x-1/2 left-1/2">
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
        </div>
      </div>
    );
  }

  const pad = spread * 0.15;
  const lo = min - pad;
  const hi = max + pad;
  const range = hi - lo;
  const pct = (v: number) => ((v - lo) / range) * 100;

  const minPct = pct(min);
  const maxPct = pct(max);
  const medPct = pct(median);

  // Use actual data quartiles for gradient hot spot width
  const sorted = values;
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.ceil(sorted.length * 0.75) - 1];

  const barWidth = maxPct - minPct;
  const rel = (v: number) => barWidth > 0 ? ((pct(v) - minPct) / barWidth) * 100 : 50;
  const medRel = rel(median);
  const q1Rel = rel(q1);
  const q3Rel = rel(q3);

  return (
    <div className={`relative mt-1 mb-0.5 overflow-visible ${selected != null ? "h-8" : "h-5"}`}>
      {/* Full track — anchored to top */}
      <div className="absolute inset-x-0 top-2 h-[3px] bg-app-border-input/25 rounded-full" />
      {/* Min–Max gradient range */}
      <div
        className="absolute top-0.5 h-3 rounded-full"
        style={{
          left: `${minPct}%`,
          width: `${barWidth}%`,
          background: `linear-gradient(to right, rgba(34,211,238,0) 0%, rgba(34,211,238,0.01) ${q1Rel * 0.6}%, rgba(34,211,238,0.06) ${q1Rel}%, rgba(34,211,238,1) ${medRel}%, rgba(34,211,238,0.06) ${q3Rel}%, rgba(34,211,238,0.01) ${100 - (100 - q3Rel) * 0.6}%, rgba(34,211,238,0) 100%)`,
        }}
      />
      {/* Individual setup dots — skip if at min or max */}
      {values.map((v, i) => v === min || v === max ? null : (
        <div key={i} className="absolute top-[7px] -translate-x-1/2" style={{ left: `${pct(v)}%` }}>
          <div className="w-1 h-1 rounded-full bg-white/40" />
        </div>
      ))}
      {/* Min marker — vertical line */}
      <div className="absolute top-0.5 -translate-x-1/2 w-[2px] h-3 bg-rose-400 rounded-full" style={{ left: `${minPct}%` }} />
      {/* Max marker — vertical line */}
      <div className="absolute top-0.5 -translate-x-1/2 w-[2px] h-3 bg-rose-400 rounded-full" style={{ left: `${maxPct}%` }} />
      {/* Median marker (amber diamond) */}
      <div className="absolute top-[5px] -translate-x-1/2" style={{ left: `${medPct}%` }}>
        <div className="w-2 h-2 bg-amber-400 rotate-45 rounded-[1px] ring-2 ring-black" />
      </div>
      {/* Selected setup — arrow pointing up + value label beneath the bar */}
      {selected != null && (
        <div className="absolute top-[16px] -translate-x-1/2 z-10 flex flex-col items-center" style={{ left: `${pct(selected)}%` }}>
          <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-emerald-400" />
          <span className="text-[11px] font-mono font-bold text-emerald-400 leading-none mt-0.5 whitespace-nowrap">{selected}{unit ?? ""}</span>
        </div>
      )}
    </div>
  );
}

/* ── Compare tab: setup list + aggregated range bars ── */

function F125SetupRanges({ trackOrdinal }: { trackOrdinal: number }) {
  const [weather, setWeather] = useState<"Dry" | "Wet">("Dry");
  const [dragRange, setDragRange] = useState<Set<number>>(new Set()); // drag-selected range for filtering
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [didDrag, setDidDrag] = useState(false);
  const [pickedIdx, setPickedIdx] = useState<number | null>(null); // single click pick
  const [filterProvider, setFilterProvider] = useState<"" | "f1laps" | "simracingsetup">("");

  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then(r => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find(t => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData, isLoading } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then(r => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const allWeatherSetups = useMemo(() => {
    if (!trackData?.setups) return [];
    return (weather === "Dry"
      ? trackData.setups.filter(s => s.weather !== "Wet")
      : trackData.setups.filter(s => s.weather === "Wet")
    ).sort((a, b) => {
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
  }, [trackData?.setups, weather]);

  const filteredSetups = useMemo(() => {
    if (!filterProvider) return allWeatherSetups;
    return allWeatherSetups.filter(x => (x.provider || "f1laps") === filterProvider);
  }, [allWeatherSetups, filterProvider]);

  const dryCount = useMemo(() => trackData?.setups?.filter(s => s.weather !== "Wet").length ?? 0, [trackData?.setups]);
  const wetCount = useMemo(() => trackData?.setups?.filter(s => s.weather === "Wet").length ?? 0, [trackData?.setups]);
  const f1lapsCount = allWeatherSetups.filter(s => (s.provider || "f1laps") === "f1laps").length;
  const srsCount = allWeatherSetups.filter(s => s.provider === "simracingsetup").length;

  const pickedSetup = pickedIdx != null ? filteredSetups[pickedIdx] ?? null : null;

  // Setups used for range computation: drag-filtered subset or all
  const rangeSetups = useMemo(() => {
    if (dragRange.size === 0) return filteredSetups;
    return filteredSetups.filter((_, i) => dragRange.has(i));
  }, [filteredSetups, dragRange]);

  const rangeData = useMemo(() => {
    if (rangeSetups.length === 0) return [];

    return SETUP_GROUPS.map(group => {
      const fields = group.fields.map(([key, label, unit]) => {
        const values = rangeSetups
          .map(s => s.setup[key])
          .filter((v): v is number => v != null);

        if (values.length === 0) return null;

        const sorted = [...values].sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const mid = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];

        return { key, label, unit: unit ?? "", min, max, median: mid, values: sorted, count: values.length };
      }).filter(Boolean) as { key: string; label: string; unit: string; min: number; max: number; median: number; values: number[]; count: number }[];

      return { title: group.title, fields };
    }).filter(g => g.fields.length > 0);
  }, [rangeSetups]);

  // Reset selections when weather/provider changes
  useEffect(() => { setDragRange(new Set()); setPickedIdx(null); }, [weather, filterProvider]);

  const handleMouseDown = (i: number) => {
    setDragStart(i);
    setDidDrag(false);
  };

  const handleMouseEnter = (i: number) => {
    if (dragStart == null) return;
    setDidDrag(true);
    const lo = Math.min(dragStart, i);
    const hi = Math.max(dragStart, i);
    const next = new Set<number>();
    for (let j = lo; j <= hi; j++) next.add(j);
    setDragRange(next);
    // Clear pick if it's outside the new drag range
    if (pickedIdx != null && !next.has(pickedIdx)) setPickedIdx(null);
  };

  const handleMouseUp = () => {
    setDragStart(null);
  };

  const handleClick = (i: number) => {
    if (didDrag) return; // was a drag, not a click
    setPickedIdx(pickedIdx === i ? null : i);
  };

  useEffect(() => {
    if (dragStart == null) return;
    const up = () => setDragStart(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragStart]);

  if (!trackSlug) return <div className="text-app-text-dim text-sm py-4 text-center">No setups available for this track</div>;
  if (isLoading || !trackData) return <div className="text-app-text-dim text-sm py-4 text-center animate-pulse">Loading setups...</div>;

  return (
    <div className="flex gap-3 h-full overflow-hidden">
      {/* Left: setup list */}
      <div className="w-[420px] shrink-0 flex flex-col min-h-0">
        {/* Filters */}
        <div className="flex items-center gap-1 mb-1.5">
          <div className="flex gap-0.5">
            {(["Dry", "Wet"] as const).map(w => (
              <button key={w} onClick={() => setWeather(w)}
                className={`text-app-unit px-2 py-1 rounded border transition-colors ${
                  weather === w ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"
                }`}>
                {w === "Dry" ? `☀ ${dryCount}` : `🌧 ${wetCount}`}
              </button>
            ))}
          </div>
          <span className="text-app-border mx-0.5">|</span>
          <div className="flex gap-0.5 ml-auto">
            {(["", "f1laps", "simracingsetup"] as const).map(p => (
              <button key={p} onClick={() => setFilterProvider(p)}
                className={`text-app-unit px-2 py-1 rounded border transition-colors ${filterProvider === p ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}>
                {p === "" ? `All (${allWeatherSetups.length})` : p === "f1laps" ? `F1Laps (${f1lapsCount})` : `SRS (${srsCount})`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 mb-1 px-1">
          {dragRange.size > 0 || pickedSetup ? (<>
            {dragRange.size > 0 && <span className="text-[10px] text-cyan-400">{dragRange.size} in range</span>}
            {pickedSetup && <span className="text-[10px] text-emerald-400">{pickedSetup.author || "Selected"}</span>}
            <button onClick={() => { setDragRange(new Set()); setPickedIdx(null); }} className="text-[10px] text-app-text-dim hover:text-app-text">Clear</button>
          </>) : (
            <span className="text-[10px] text-app-text-dim">Drag to filter range, click to pick a setup</span>
          )}
        </div>

        {/* Setup list */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20 select-none">
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt border-b border-app-border/20 sticky top-0 z-10">
            <span className="text-[9px] text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-[9px] text-app-text-dim uppercase w-7 shrink-0">Src</span>
            <span className="text-[9px] text-app-text-dim uppercase flex-1">Author / Team</span>
            <span className="text-[9px] text-app-text-dim uppercase w-8 text-center">Input</span>
            <span className="text-[9px] text-app-text-dim uppercase w-12 text-center">Info</span>
            <span className="text-[9px] text-app-text-dim uppercase w-16 text-right">Time</span>
          </div>
          {filteredSetups.length === 0 ? (
            <div className="text-app-text-dim text-xs py-4 text-center">No {weather.toLowerCase()} setups</div>
          ) : filteredSetups.map((s, i) => {
            const inRange = dragRange.size === 0 || dragRange.has(i);
            const isPicked = pickedIdx === i;
            return (
            <div
              key={i}
              onMouseDown={() => handleMouseDown(i)}
              onMouseEnter={() => handleMouseEnter(i)}
              onMouseUp={handleMouseUp}
              onClick={() => handleClick(i)}
              className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                isPicked ? "bg-emerald-500/15" : inRange && dragRange.size > 0 ? "bg-cyan-500/8" : "hover:bg-app-surface-alt/30"
              } ${!inRange ? "opacity-40" : ""}`}
            >
              <span className="text-app-unit text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <ProviderBadge provider={s.provider} />
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-unit font-medium text-app-text truncate">{s.author || "—"}</span>
                {s.team && <span className="text-[9px] text-app-text-dim truncate">({s.team})</span>}
              </div>
              <div className="shrink-0 w-8 text-center">
                {s.inputDevice === "wheel" && <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">WHL</span>}
                {s.inputDevice === "controller" && <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/20 text-orange-300 font-bold">PAD</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0 w-12 justify-center">
                {s.videoUrl && <span className="text-[9px] text-red-400" title="Has hotlap video">▶</span>}
                {s.weather === "Wet" && <span className="text-[8px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">WET</span>}
              </div>
              <span className="text-app-unit font-mono text-emerald-400 shrink-0 w-16 text-right">{s.lapTime || "—"}</span>
            </div>
          ); })}
        </div>
      </div>

      {/* Right: range bars */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 @container">
        {/* Legend — matches filter row height */}
        <div className="flex items-center gap-3 mb-1.5 text-[10px] text-app-text-secondary" style={{ minHeight: "1.625rem" }}>
          <span className="flex items-center gap-1">
            <span className="inline-block w-[2px] h-3 bg-rose-400 rounded-full" />
            Min / Max
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-12 h-2.5 rounded-sm" style={{ background: "linear-gradient(to right, rgba(34,211,238,0), rgba(34,211,238,1))" }} />
            Popularity
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-amber-400 rotate-45 rounded-[1px]" />
            Median
          </span>
          {pickedSetup && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              {pickedSetup.author || "Selected"}
            </span>
          )}
        </div>
        {/* Range cards */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filteredSetups.length === 0 ? (
            <div className="text-app-text-dim text-sm py-4 text-center">No {weather.toLowerCase()} setups available</div>
          ) : <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 gap-x-4 gap-y-1">
            {rangeData.map(group => (
              <div key={group.title} className="rounded-lg border border-app-border bg-transparent p-2 mt-1">
                <div className="text-xs text-app-accent uppercase tracking-wider font-bold mb-1.5 border-b border-app-border/20 pb-0.5">
                  {group.title}
                </div>
                {group.fields.map(f => {
                  const selVal = pickedSetup ? pickedSetup.setup[f.key] ?? null : null;
                  return (
                    <div key={f.key} className="px-3 py-2 mb-1.5">
                      <div className="flex items-center justify-between mb-0">
                        <span className="text-app-label font-semibold text-app-text">{f.label}</span>
                        <div className="flex items-center gap-2 text-app-label font-mono">
                          <span className="text-rose-400">{f.min}{f.unit}</span>
                          <span className="text-app-text-dim">—</span>
                          <span className="text-amber-400 font-bold">{f.median}{f.unit}</span>
                          <span className="text-app-text-dim">—</span>
                          <span className="text-rose-400">{f.max}{f.unit}</span>
                        </div>
                      </div>
                      <SetupRangeBar min={f.min} max={f.max} median={f.median} values={f.values} selected={selVal} unit={f.unit} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>}
        </div>
      </div>
    </div>
  );
}
