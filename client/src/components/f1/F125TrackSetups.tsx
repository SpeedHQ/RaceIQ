import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { SETUP_GROUPS } from "@/components/f1/f125-setup-groups";
import { SetupRangeBar } from "@/components/SetupRangeBar";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TRow } from "@/components/ui/AppTable";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";

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

function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "f1laps")
    return (
      <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded shrink-0" data-provider-brand="f1laps">
        F1L
      </span>
    );
  if (provider === "simracingsetup")
    return (
      <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded shrink-0" data-provider-brand="simracingsetup">
        SRS
      </span>
    );
  return null;
}

function getYouTubeVid(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch {
    /* invalid URL */
  }
  return null;
}

function SetupVideo({ url }: { url: string }) {
  const vid = getYouTubeVid(url);
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
}

export function F125SetupsWithGuide({ trackOrdinal, trackName }: { trackOrdinal: number; trackName: string }) {
  const search = useSearch({ strict: false }) as { subtab?: string };
  const navigate = useNavigate();
  const validSubTabs = ["setups", "ranges"] as const;
  type SubTab = (typeof validSubTabs)[number];
  const subTab: SubTab = (validSubTabs as readonly string[]).includes(search.subtab ?? "") ? (search.subtab as SubTab) : "setups";
  const setSubTab = (tab: SubTab) => {
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, subtab: tab === "setups" ? undefined : tab }) as never, replace: true });
  };

  const uiLocale = useUiStore((s) => s.uiLocale);
  const tabLabels = useMemo(() => ({ setups: m.f1setup_setups(), ranges: m.f1setup_compare() }), [uiLocale]);

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex gap-1 shrink-0">
        {(["setups", "ranges"] as const).map((tab) => (
          <Button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={`text-app-compact px-3 py-1 rounded border transition-colors ${
              subTab === tab ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"
            }`}
          >
            {tabLabels[tab]}
          </Button>
        ))}
      </div>
      {subTab === "setups" ? <F125TrackSetups trackOrdinal={trackOrdinal} trackName={trackName} /> : <F125SetupRanges trackOrdinal={trackOrdinal} />}
    </div>
  );
}

function sourceDisplayName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackSummary[]),
  });
  const trackSlug = tracks.find((t) => t.trackOrdinal === trackOrdinal)?.trackSlug;
  const { data: trackData } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then((r) => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  const guides = trackData?.trackGuide ?? [];
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<"guide" | "setup">("guide");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const activeGuide = guides.find((g) => g.source === selectedSource) ?? guides[0];

  if (guides.length === 0) return <div className="text-app-text-secondary text-app-compact p-4">{m.f1setup_no_guide()}</div>;

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Source list */}
      <div className={`w-full md:w-56 shrink-0 flex flex-col gap-1 ${mobileView === "detail" ? "hidden md:flex" : ""}`}>
        {guides.map((g) => {
          const isActive = g.source === activeGuide?.source;
          const sectionCount = g.sections?.length ?? 0;
          return (
            <Button
              key={g.source}
              variant="plain"
              size="content"
              onClick={() => {
                setSelectedSource(g.source);
                setMobileView("detail");
              }}
              className={`text-left px-2 py-2 rounded border transition-colors ${
                isActive ? "border-app-accent/40 bg-app-accent/10" : "border-app-border hover:border-app-border-hover bg-app-surface-alt/30 hover:bg-app-surface-hover"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-app-subtext font-medium ${isActive ? "text-app-accent" : "text-app-text"}`}>{sourceDisplayName(g.source)}</span>
                {sectionCount > 0 && <span className="px-1 py-0.5 text-app-nano font-bold uppercase rounded bg-status-info/20 text-status-info">{m.label_text()}</span>}
                {g.videoUrl && (
                  <span className="provider-badge px-1 py-0.5 text-app-nano font-bold uppercase rounded" data-provider-brand="youtube">
                    YT
                  </span>
                )}
              </div>
              <Table density="compact" fit variant="embedded">
                <TBody>
                  {g.setupTips && (
                    <TRow>
                      <TD tone="dim">{m.f1setup_setup_tips_label()}</TD>
                      <TD>Yes</TD>
                    </TRow>
                  )}
                  {g.drivingTips && (
                    <TRow>
                      <TD tone="dim">{m.f1setup_driving_tips_label()}</TD>
                      <TD>Yes</TD>
                    </TRow>
                  )}
                </TBody>
              </Table>
            </Button>
          );
        })}
      </div>

      {/* Guide content */}
      {activeGuide && (
        <div className={`flex-1 min-w-0 flex flex-col min-h-0 ${mobileView === "list" ? "hidden md:flex" : ""}`}>
          {/* Back button (mobile only) */}
          <Button variant="app-outline" size="default" onClick={() => setMobileView("list")} className="md:hidden self-start mb-3">
            &larr; Back to guides
          </Button>
          {/* Content tabs + source link */}
          <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
            <Button
              onClick={() => setContentTab("guide")}
              className={`text-app-label px-2 py-0.5 rounded border transition-colors ${contentTab === "guide" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
            >
              {m.f1setup_guide_tab()}
            </Button>
            {activeGuide.setupTips && (
              <Button
                onClick={() => setContentTab("setup")}
                className={`text-app-label px-2 py-0.5 rounded border transition-colors ${contentTab === "setup" ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
              >
                {m.f1setup_setup_tips_tab()}
              </Button>
            )}
            {activeGuide.source && (
              <a href={activeGuide.source} target="_blank" rel="noopener noreferrer" className="text-app-caption text-app-text-muted hover:text-app-text underline underline-offset-2">
                View on {sourceDisplayName(activeGuide.source)} ↗
              </a>
            )}
          </div>
          <div className="overflow-y-auto rounded-lg border border-app-border/15 bg-app-surface-alt/15 p-3 flex-1">
            {contentTab === "guide" && (
              <>
                {activeGuide.videoUrl && (
                  <div className="mb-4 md:float-right md:ml-4 md:mb-4 w-full md:w-[45%] rounded-lg overflow-hidden border border-app-border/30">
                    <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                      <iframe
                        src={toEmbedUrl(activeGuide.videoUrl)}
                        title={m.f1setup_track_guide()}
                        className="absolute inset-0 w-full h-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
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
                    <p className="text-app-text font-semibold text-sm mb-1">{m.f1setup_driving_tips_tab()}</p>
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
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find((t) => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData, isLoading } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then((r) => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const filteredSetups = useMemo(() => {
    if (!trackData?.setups) return [];
    let s = trackData.setups;
    if (filterProvider) s = s.filter((x) => (x.provider || "f1laps") === filterProvider);
    if (filterWeather) s = s.filter((x) => x.weather === filterWeather);
    return [...s].sort((a, b) => {
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
  }, [trackData?.setups, filterProvider, filterWeather]);

  // Resolve setup from URL param
  useEffect(() => {
    if (!search.setup || filteredSetups.length === 0) return;
    const idx = filteredSetups.findIndex((s) => setupId(s) === search.setup);
    if (idx >= 0 && idx !== selectedIdx) setSelectedIdx(idx);
  }, [search.setup, filteredSetups]);

  const syncSetupUrl = (i: number) => {
    const s = filteredSetups[i];
    if (s) navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, setup: setupId(s) })) as never, replace: true });
  };
  const selectSetup = (i: number) => {
    setSelectedIdx(i);
    setMobileView("detail");
    syncSetupUrl(i);
  };
  const resetSetup = () => {
    setSelectedIdx(0);
    syncSetupUrl(0);
  };

  if (!trackSlug) return <div className="text-app-text-dim text-sm py-4 text-center">{m.f1setup_no_setups_this_track()}</div>;
  if (isLoading || !trackData) return <div className="text-app-text-dim text-sm py-4 text-center animate-pulse">{m.f1setup_loading_setups()}</div>;
  if (!trackData.setups?.length) return <div className="text-app-text-dim text-sm py-4 text-center">{m.f1setup_no_setups()}</div>;

  const setup = filteredSetups[selectedIdx] ?? filteredSetups[0];
  const f1lapsCount = trackData.setups.filter((s) => (s.provider || "f1laps") === "f1laps").length;
  const srsCount = trackData.setups.filter((s) => s.provider === "simracingsetup").length;
  const wetCount = trackData.setups.filter((s) => s.weather === "Wet").length;
  const dryCount = trackData.setups.filter((s) => s.weather !== "Wet").length;

  return (
    <div className="flex gap-3 md:h-full md:overflow-hidden">
      {/* Left: filters + setup list */}
      <div className={`w-full md:w-[420px] shrink-0 flex flex-col min-h-0 ${mobileView === "detail" ? "hidden md:flex" : ""}`}>
        {/* Filters — single row */}
        <div className="flex items-center gap-1 mb-1.5">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider shrink-0">Setups ({filteredSetups.length})</div>
          <div className="flex gap-0.5 ml-auto">
            {(["", "f1laps", "simracingsetup"] as const).map((p) => (
              <Button
                key={p}
                onClick={() => {
                  setFilterProvider(p);
                  resetSetup();
                }}
                className={`text-app-compact px-2 py-1 rounded border transition-colors ${filterProvider === p ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
              >
                {p === "" ? "All" : p === "f1laps" ? `F1Laps (${f1lapsCount})` : `SRS (${srsCount})`}
              </Button>
            ))}
          </div>
          <span className="text-app-border mx-0.5">|</span>
          <div className="flex gap-0.5">
            {(["Dry", "Wet"] as const).map((w) => (
              <Button
                key={w}
                onClick={() => {
                  setFilterWeather(filterWeather === w ? "" : w);
                  resetSetup();
                }}
                className={`text-app-compact px-2 py-1 rounded border transition-colors ${filterWeather === w ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
              >
                {w === "Dry" ? `☀ ${dryCount}` : `🌧 ${wetCount}`}
              </Button>
            ))}
          </div>
        </div>

        {/* Setup list */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20">
          {/* Header */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt border-b border-app-border/20 sticky top-0 z-10">
            <span className="text-app-micro text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
            <span className="text-app-micro text-app-text-dim uppercase w-7 shrink-0">Src</span>
            <span className="text-app-micro text-app-text-dim uppercase flex-1">{m.label_author_team()}</span>
            <span className="text-app-micro text-app-text-dim uppercase w-8 text-center">{m.label_input()}</span>
            <span className="text-app-micro text-app-text-dim uppercase w-12 text-center">{m.label_info()}</span>
            <span className="text-app-micro text-app-text-dim uppercase w-16 text-right">{m.label_time()}</span>
          </div>
          {filteredSetups.map((s, i) => (
            <div
              key={i}
              onClick={() => selectSetup(i)}
              className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                selectedIdx === i ? "bg-app-accent/10" : "hover:bg-app-surface-hover/30"
              }`}
            >
              <span className="text-app-compact text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <ProviderBadge provider={s.provider} />
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-compact font-medium text-app-text truncate">{s.author || "—"}</span>
                {s.team && <span className="text-app-micro text-app-text-dim truncate">({s.team})</span>}
              </div>
              <div className="shrink-0 w-8 text-center">
                {s.inputDevice === "wheel" && (
                  <span className="input-device-badge text-app-nano px-1 py-0.5 rounded font-bold" data-input-device="wheel">
                    WHL
                  </span>
                )}
                {s.inputDevice === "controller" && (
                  <span className="input-device-badge text-app-nano px-1 py-0.5 rounded font-bold" data-input-device="controller">
                    PAD
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0 w-12 justify-center">
                {s.videoUrl && (
                  <span className="text-app-micro" style={{ color: "var(--brand-provider-youtube)" }} title={m.accsetup_setup_type_has_video_title()}>
                    ▶
                  </span>
                )}
                {s.weather === "Wet" && <span className="weather-wet-badge text-app-nano px-1 py-0.5 rounded font-bold">WET</span>}
              </div>
              <span className="text-app-compact font-mono shrink-0 w-16 text-right" style={{ color: "var(--lap-record)" }}>
                {s.lapTime || "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: setup detail (2/3) + video (1/3) */}
      {setup && (
        <div className={`flex-1 min-w-0 flex flex-col md:flex-row gap-3 md:h-full md:overflow-hidden ${mobileView === "list" ? "hidden md:flex" : ""}`}>
          {/* Back button (mobile only) */}
          <Button variant="app-outline" size="default" onClick={() => setMobileView("list")} className="md:hidden self-start">
            &larr; {m.f1setup_back_to_setups()}
          </Button>
          {/* Setup detail column */}
          <div className="flex-1 min-w-0 md:overflow-y-auto space-y-2">
            {/* Header */}
            <div className="flex items-center gap-2 flex-wrap">
              <ProviderBadge provider={setup.provider} />
              <span className="text-app-body font-bold text-app-text">{setup.author || "Unknown"}</span>
              <span className="text-app-compact text-app-text-secondary">
                {setup.team && `${setup.team} · `}
                {setup.lapTime}
                {setup.inputDevice && ` · ${setup.inputDevice === "wheel" ? m.label_wheel() : m.f1setup_controller()}`}
                {setup.weather === "Wet" && " · Wet"}
                {setup.sessionType && ` · ${setup.sessionType}`}
              </span>
              {setup.source && (
                <a
                  href={setup.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 text-app-compact bg-app-accent/15 text-app-accent rounded hover:bg-app-accent/25 transition-colors"
                >
                  {m.f1setup_view_source()}
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
          <div className="w-1/2 shrink-0 overflow-hidden">{setup.videoUrl && <SetupVideo url={setup.videoUrl} />}</div>
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
  const longPressTimer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<number | null>(null);
  const [carouselEl, setCarouselEl] = useState<HTMLDivElement | null>(null);
  const [carouselPage, setCarouselPage] = useState(0);
  const gotoCarouselPage = (i: number) => {
    if (!carouselEl) return;
    carouselEl.scrollTo({ left: carouselEl.clientWidth * i, behavior: "smooth" });
    setCarouselPage(i);
  };
  useEffect(() => {
    if (!carouselEl) return;
    const onScroll = () => {
      const idx = Math.round(carouselEl.scrollLeft / carouselEl.clientWidth);
      setCarouselPage(idx);
    };
    carouselEl.addEventListener("scroll", onScroll, { passive: true });
    return () => carouselEl.removeEventListener("scroll", onScroll);
  }, [carouselEl]);

  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find((t) => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData, isLoading } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then((r) => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const allWeatherSetups = useMemo(() => {
    if (!trackData?.setups) return [];
    return (weather === "Dry" ? trackData.setups.filter((s) => s.weather !== "Wet") : trackData.setups.filter((s) => s.weather === "Wet")).sort((a, b) => {
      if (!a.lapTime) return 1;
      if (!b.lapTime) return -1;
      return a.lapTime.localeCompare(b.lapTime);
    });
  }, [trackData?.setups, weather]);

  const filteredSetups = useMemo(() => {
    if (!filterProvider) return allWeatherSetups;
    return allWeatherSetups.filter((x) => (x.provider || "f1laps") === filterProvider);
  }, [allWeatherSetups, filterProvider]);

  const dryCount = useMemo(() => trackData?.setups?.filter((s) => s.weather !== "Wet").length ?? 0, [trackData?.setups]);
  const wetCount = useMemo(() => trackData?.setups?.filter((s) => s.weather === "Wet").length ?? 0, [trackData?.setups]);
  const f1lapsCount = allWeatherSetups.filter((s) => (s.provider || "f1laps") === "f1laps").length;
  const srsCount = allWeatherSetups.filter((s) => s.provider === "simracingsetup").length;

  const pickedSetup = pickedIdx != null ? (filteredSetups[pickedIdx] ?? null) : null;

  // Setups used for range computation: drag-filtered subset or all
  const rangeSetups = useMemo(() => {
    if (dragRange.size === 0) return filteredSetups;
    return filteredSetups.filter((_, i) => dragRange.has(i));
  }, [filteredSetups, dragRange]);

  const rangeData = useMemo(() => {
    if (rangeSetups.length === 0) return [];

    return SETUP_GROUPS.map((group) => {
      const fields = group.fields
        .map(([key, label, unit]) => {
          const values = rangeSetups.map((s) => s.setup[key]).filter((v): v is number => v != null);

          if (values.length === 0) return null;

          const sorted = [...values].sort((a, b) => a - b);
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          const mid = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];

          return { key, label, unit: unit ?? "", min, max, median: mid, values: sorted, count: values.length };
        })
        .filter(Boolean) as { key: string; label: string; unit: string; min: number; max: number; median: number; values: number[]; count: number }[];

      return { title: group.title, fields };
    }).filter((g) => g.fields.length > 0);
  }, [rangeSetups]);

  // Reset selections when weather/provider changes
  useEffect(() => {
    setDragRange(new Set());
    setPickedIdx(null);
  }, [weather, filterProvider]);

  const handleMouseDown = (i: number) => {
    dragStartRef.current = i;
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
    dragStartRef.current = null;
    setDragStart(null);
  };

  const handleClick = (i: number) => {
    if (didDrag) return; // was a drag, not a click
    setPickedIdx(pickedIdx === i ? null : i);
  };

  useEffect(() => {
    dragStartRef.current = dragStart;
    if (dragStart == null) return;
    const up = () => setDragStart(null);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragStart]);

  // Non-passive touchmove on document so we can preventDefault (block scroll)
  // during drag-select no matter which ancestor owns the scroll.
  useEffect(() => {
    const onMove = (e: TouchEvent) => {
      if (dragStartRef.current != null) e.preventDefault();
    };
    document.addEventListener("touchmove", onMove, { passive: false });
    return () => document.removeEventListener("touchmove", onMove);
  }, []);

  if (!trackSlug) return <div className="text-app-text-dim text-sm py-4 text-center">{m.f1setup_no_setups_available()}</div>;
  if (isLoading || !trackData) return <div className="text-app-text-dim text-sm py-4 text-center animate-pulse">{m.f1setup_loading_setups()}</div>;

  return (
    <div className="flex flex-col md:flex-row md:gap-3 md:h-full md:overflow-hidden">
      {/* Mobile tab bar */}
      <div className="md:hidden flex items-center gap-1 border-b border-app-border">
        {["List", "Compare"].map((label, i) => (
          <Button
            key={label}
            onClick={() => gotoCarouselPage(i)}
            className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 -mb-px transition-colors ${carouselPage === i ? "border-app-accent text-app-accent" : "border-transparent text-app-text-muted"}`}
          >
            {label}
          </Button>
        ))}
      </div>
      {/* Carousel on mobile, side-by-side at md+ */}
      <div ref={setCarouselEl} className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth items-start md:contents">
        {/* Left: setup list */}
        <div className="snap-center shrink-0 w-full md:w-[420px] md:shrink-0 flex flex-col min-h-0">
          {/* Filters */}
          <div className="flex items-center gap-1 mb-1.5">
            <div className="flex gap-0.5">
              {(["Dry", "Wet"] as const).map((w) => (
                <Button
                  key={w}
                  onClick={() => setWeather(w)}
                  className={`text-app-compact px-2 py-1 rounded border transition-colors ${
                    weather === w ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"
                  }`}
                >
                  {w === "Dry" ? `☀ ${dryCount}` : `🌧 ${wetCount}`}
                </Button>
              ))}
            </div>
            <span className="text-app-border mx-0.5">|</span>
            <div className="flex gap-0.5 ml-auto">
              {(["", "f1laps", "simracingsetup"] as const).map((p) => (
                <Button
                  key={p}
                  onClick={() => setFilterProvider(p)}
                  className={`text-app-compact px-2 py-1 rounded border transition-colors ${filterProvider === p ? "border-app-accent/50 bg-app-accent/15 text-app-accent" : "border-app-border text-app-text-secondary hover:text-app-text"}`}
                >
                  {p === "" ? `All (${allWeatherSetups.length})` : p === "f1laps" ? `F1Laps (${f1lapsCount})` : `SRS (${srsCount})`}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-1 px-1">
            {dragRange.size > 0 || pickedSetup ? (
              <>
                {dragRange.size > 0 && <span className="text-app-caption text-app-accent">{dragRange.size} in range</span>}
                {pickedSetup && <span className="text-app-caption text-status-success">{pickedSetup.author || "Selected"}</span>}
                <Button
                  onClick={() => {
                    setDragRange(new Set());
                    setPickedIdx(null);
                  }}
                  className="text-app-caption text-app-text-dim hover:text-app-text"
                >
                  {m.label_clear()}
                </Button>
              </>
            ) : (
              <span className="text-app-caption text-app-text-dim">{m.f1setup_drag_filter_hint()}</span>
            )}
          </div>

          {/* Setup list */}
          <div
            ref={listRef}
            className={`flex-1 min-h-0 overflow-y-auto rounded-lg border border-app-border/20 select-none ${dragStart != null ? "touch-none" : ""}`}
            onTouchMove={(e) => {
              // Cancel pending long-press if user starts scrolling before it fires
              if (longPressTimer.current) {
                window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
              if (dragStart == null) return;
              setDidDrag(true);
              const t = e.touches[0];
              if (!t) return;
              const target = document.elementFromPoint(t.clientX, t.clientY);
              const row = target?.closest<HTMLElement>("[data-setup-idx]");
              if (!row) return;
              const idx = Number(row.dataset.setupIdx);
              if (!Number.isNaN(idx)) handleMouseEnter(idx);
            }}
            onTouchEnd={(e) => {
              if (longPressTimer.current) {
                window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
              if (didDrag) e.preventDefault();
              handleMouseUp();
            }}
            onTouchCancel={() => {
              if (longPressTimer.current) {
                window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
              handleMouseUp();
            }}
          >
            {/* Header */}
            <div className="flex items-center gap-1.5 px-2 py-1 bg-app-surface-alt border-b border-app-border/20 sticky top-0 z-10">
              <span className="text-app-micro text-app-text-dim uppercase w-4 text-right shrink-0">#</span>
              <span className="text-app-micro text-app-text-dim uppercase w-7 shrink-0">Src</span>
              <span className="text-app-micro text-app-text-dim uppercase flex-1">{m.label_author_team()}</span>
              <span className="text-app-micro text-app-text-dim uppercase w-8 text-center">{m.label_input()}</span>
              <span className="text-app-micro text-app-text-dim uppercase w-12 text-center">{m.label_info()}</span>
              <span className="text-app-micro text-app-text-dim uppercase w-16 text-right">{m.label_time()}</span>
            </div>
            {filteredSetups.length === 0 ? (
              <div className="text-app-text-dim text-xs py-4 text-center">No {weather.toLowerCase()} setups</div>
            ) : (
              filteredSetups.map((s, i) => {
                const inRange = dragRange.size === 0 || dragRange.has(i);
                const isPicked = pickedIdx === i;
                return (
                  <div
                    key={i}
                    data-setup-idx={i}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{ WebkitTouchCallout: "none" }}
                    onMouseDown={() => handleMouseDown(i)}
                    onMouseEnter={() => handleMouseEnter(i)}
                    onMouseUp={handleMouseUp}
                    onTouchStart={() => {
                      setDidDrag(false);
                      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
                      longPressTimer.current = window.setTimeout(() => {
                        handleMouseDown(i);
                        longPressTimer.current = null;
                      }, 400);
                    }}
                    onClick={() => handleClick(i)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-b border-app-border/10 transition-colors ${
                      isPicked ? "bg-status-success/15" : inRange && dragRange.size > 0 ? "bg-app-accent/8" : "hover:bg-app-surface-hover/30"
                    } ${!inRange ? "opacity-40" : ""}`}
                  >
                    <span className="text-app-compact text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
                    <ProviderBadge provider={s.provider} />
                    <div className="flex-1 min-w-0 flex items-center gap-1">
                      <span className="text-app-compact font-medium text-app-text truncate">{s.author || "—"}</span>
                      {s.team && <span className="text-app-micro text-app-text-dim truncate">({s.team})</span>}
                    </div>
                    <div className="shrink-0 w-8 text-center">
                      {s.inputDevice === "wheel" && (
                        <span className="input-device-badge text-app-nano px-1 py-0.5 rounded font-bold" data-input-device="wheel">
                          WHL
                        </span>
                      )}
                      {s.inputDevice === "controller" && (
                        <span className="input-device-badge text-app-nano px-1 py-0.5 rounded font-bold" data-input-device="controller">
                          PAD
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 w-12 justify-center">
                      {s.videoUrl && (
                        <span className="text-app-micro" style={{ color: "var(--brand-provider-youtube)" }} title={m.accsetup_setup_type_has_video_title()}>
                          ▶
                        </span>
                      )}
                      {s.weather === "Wet" && <span className="weather-wet-badge text-app-nano px-1 py-0.5 rounded font-bold">WET</span>}
                    </div>
                    <span className="text-app-compact font-mono shrink-0 w-16 text-right" style={{ color: "var(--lap-record)" }}>
                      {s.lapTime || "—"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: range bars */}
        <div className="snap-center shrink-0 w-full md:flex-1 md:min-w-0 flex flex-col min-h-0 @container">
          {/* Legend — matches filter row height */}
          <div className="flex items-center gap-3 mb-1.5 text-app-caption text-app-text-secondary" style={{ minHeight: "1.625rem" }}>
            <span className="flex items-center gap-1">
              <span className="inline-block w-[2px] h-3 rounded-full" style={{ backgroundColor: "var(--setup-range-limit)" }} />
              {m.f1setup_min_max()}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-12 h-2.5 rounded-sm" style={{ background: "linear-gradient(to right, transparent, var(--app-accent))" }} />
              {m.f1setup_popularity()}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rotate-45 rounded-[1px]" style={{ backgroundColor: "var(--setup-range-median)" }} />
              {m.f1setup_median()}
            </span>
            {pickedSetup && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "var(--setup-range-selected)" }} />
                {pickedSetup.author || "Selected"}
              </span>
            )}
          </div>
          {/* Range cards */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {filteredSetups.length === 0 ? (
              <div className="text-app-text-dim text-sm py-4 text-center">No {weather.toLowerCase()} setups available</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1">
                {rangeData.map((group) => (
                  <div key={group.title} className="rounded-lg border border-app-border bg-transparent p-2 mt-1">
                    <div className="text-xs text-app-accent uppercase tracking-wider font-bold mb-1.5 border-b border-app-border/20 pb-0.5">{group.title}</div>
                    {group.fields.map((f) => {
                      const selVal = pickedSetup ? (pickedSetup.setup[f.key] ?? null) : null;
                      return (
                        <div key={f.key} className="px-3 py-2 mb-1.5">
                          <div className="flex items-center justify-between mb-0">
                            <span className="text-app-label font-semibold text-app-text">{f.label}</span>
                            <div className="flex items-center gap-2 text-app-label font-mono">
                              <span style={{ color: "var(--setup-range-limit)" }}>
                                {f.min}
                                {f.unit}
                              </span>
                              <span className="text-app-text-dim">—</span>
                              <span className="font-bold" style={{ color: "var(--setup-range-median)" }}>
                                {f.median}
                                {f.unit}
                              </span>
                              <span className="text-app-text-dim">—</span>
                              <span style={{ color: "var(--setup-range-limit)" }}>
                                {f.max}
                                {f.unit}
                              </span>
                            </div>
                          </div>
                          <SetupRangeBar min={f.min} max={f.max} median={f.median} values={f.values} selected={selVal} unit={f.unit} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Bottom swipe banner (mobile only) */}
      <Button
        type="button"
        onClick={() => gotoCarouselPage(carouselPage === 0 ? 1 : 0)}
        className="md:hidden mt-3 flex items-center justify-center gap-2 py-3 rounded-lg bg-app-surface-alt/50 border border-app-border/40 text-xs text-app-text-muted uppercase tracking-wider select-none"
      >
        <span>{carouselPage === 0 ? "Swipe here to view comparison →" : "← Swipe here to view list"}</span>
      </Button>
    </div>
  );
}
