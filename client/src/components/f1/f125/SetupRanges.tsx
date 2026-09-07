import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderBadge } from "@/components/f1/f125/ProviderBadge";
import { setupId } from "@/components/f1/f125/setup-utils";
import type { F125TrackData, F125TrackSummary } from "@/components/f1/f125/types";
import { SETUP_GROUPS } from "@/components/f1/f125-setup-groups";
import { SetupRangeBar } from "@/components/SetupRangeBar";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

/* ── Compare tab: setup list + aggregated range bars ── */

export function F125SetupRanges({ trackOrdinal }: { trackOrdinal: number }) {
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
    <div className="flex flex-col @3xl/workspace:h-full @3xl/workspace:flex-row @3xl/workspace:gap-3 @3xl/workspace:overflow-hidden">
      {/* Mobile tab bar */}
      <div className="flex items-center gap-1 border-b border-app-border @3xl/workspace:hidden">
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
      <div ref={setCarouselEl} className="flex snap-x snap-mandatory items-start overflow-x-auto scroll-smooth @3xl/workspace:contents">
        {/* Left: setup list */}
        <div className="flex min-h-0 w-full shrink-0 snap-center flex-col @3xl/workspace:w-[420px] @3xl/workspace:shrink-0">
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
                  <Button
                    variant="plain"
                    size="content"
                    type="button"
                    key={setupId(s)}
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
                    className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left cursor-pointer border-b border-app-border/10 transition-colors ${
                      isPicked ? "bg-status-success/15" : inRange && dragRange.size > 0 ? "bg-app-accent/8" : "hover:bg-app-surface-hover/30"
                    } ${!inRange ? "opacity-40" : ""}`}
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
                );
              })
            )}
          </div>
        </div>

        {/* Right: range bars */}
        <div className="@container flex min-h-0 w-full shrink-0 snap-center flex-col @3xl/workspace:min-w-0 @3xl/workspace:flex-1">
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
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 @3xl/workspace:grid-cols-2 @7xl/workspace:grid-cols-3">
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
        className="mt-3 flex select-none items-center justify-center gap-2 rounded-lg border border-app-border/40 bg-app-surface-alt/50 py-3 text-xs text-app-text-muted uppercase tracking-wider @3xl/workspace:hidden"
      >
        <span>{carouselPage === 0 ? "Swipe here to view comparison →" : "← Swipe here to view list"}</span>
      </Button>
    </div>
  );
}
