import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ProviderBadge } from "@/components/f1/f125/ProviderBadge";
import { F125SetupRanges } from "@/components/f1/f125/SetupRanges";
import { setupId } from "@/components/f1/f125/setup-utils";
import type { F125TrackData, F125TrackSummary } from "@/components/f1/f125/types";
import { getYouTubeVideoId } from "@/components/f1/f125/video-url";
import { SETUP_GROUPS } from "@/components/f1/f125-setup-groups";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";

function SetupVideo({ url }: { url: string }) {
  const vid = getYouTubeVideoId(url);
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
    <div className="flex gap-3 @3xl/workspace:h-full @3xl/workspace:overflow-hidden">
      {/* Left: filters + setup list */}
      <div className={`min-h-0 w-full shrink-0 flex-col @3xl/workspace:w-[420px] ${mobileView === "detail" ? "hidden @3xl/workspace:flex" : "flex"}`}>
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
            <Button
              variant="plain"
              size="content"
              type="button"
              key={setupId(s)}
              onClick={() => selectSetup(i)}
              className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left cursor-pointer border-b border-app-border/10 transition-colors ${
                selectedIdx === i ? "bg-app-accent/10" : "hover:bg-app-surface-hover/30"
              }`}
            >
              <span className="text-app-compact text-app-text-dim font-mono w-4 text-right shrink-0">{i + 1}</span>
              <ProviderBadge provider={s.provider} />
              <span className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-app-compact font-medium text-app-text truncate">{s.author || "—"}</span>
                {s.team && <span className="text-app-micro text-app-text-dim truncate">({s.team})</span>}
              </span>
              <span className="shrink-0 w-8 text-center">
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
              </span>
              <span className="flex items-center gap-1 shrink-0 w-12 justify-center">
                {s.videoUrl && (
                  <span className="text-app-micro" style={{ color: "var(--brand-provider-youtube)" }} title={m.accsetup_setup_type_has_video_title()}>
                    ▶
                  </span>
                )}
                {s.weather === "Wet" && <span className="weather-wet-badge text-app-nano px-1 py-0.5 rounded font-bold">WET</span>}
              </span>
              <span className="text-app-compact font-mono shrink-0 w-16 text-right" style={{ color: "var(--lap-record)" }}>
                {s.lapTime || "—"}
              </span>
            </Button>
          ))}
        </div>
      </div>

      {/* Right: setup detail (2/3) + video (1/3) */}
      {setup && (
        <div className={`min-w-0 flex-1 flex-col gap-3 @3xl/workspace:h-full @3xl/workspace:flex-row @3xl/workspace:overflow-hidden ${mobileView === "list" ? "hidden @3xl/workspace:flex" : "flex"}`}>
          {/* Back button (mobile only) */}
          <Button variant="app-outline" size="default" onClick={() => setMobileView("list")} className="self-start @3xl/workspace:hidden">
            &larr; {m.f1setup_back_to_setups()}
          </Button>
          {/* Setup detail column */}
          <div className="min-w-0 flex-1 space-y-2 @3xl/workspace:overflow-y-auto">
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
