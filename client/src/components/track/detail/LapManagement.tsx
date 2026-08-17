import { isTimedLapEligibilityUsable } from "@shared/racing/quality/policies";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { LapStatus } from "@/components/LapStatus";
import { LapQualityBadge } from "@/components/LapQualityBadge";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { SearchMultiSelect } from "@/components/ui/SearchMultiSelect";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { getGameRoute } from "@/stores/game";
import type { TrackInfo } from "../types";
import { carClassColor } from "./helpers";
import { LapStatsPanel } from "./LapStatsPanel";
import type { TrackLap } from "./types";

interface LapManagementProps {
  track: TrackInfo;
  gameId: string | null;
  trackLaps: TrackLap[];
  filteredLaps: TrackLap[];
  uniqueCars: { carOrdinal: number; carName: string; carClass: string }[];
  uniqueDivisions: string[];
  hasForzaTunes: boolean;
  hideClassCol: boolean;
  selectedDivision: string | null;
  setSelectedDivision: (value: string | null) => void;
  selectedCars: Set<number>;
  setSelectedCars: (value: Set<number>) => void;
  toggleCar: (ordinal: number) => void;
  selectedLaps: Set<number>;
  setSelectedLaps: (value: Set<number>) => void;
  toggleLapSelect: (lapId: number) => void;
  toggleAllLaps: () => void;
  sectorCount: number;
  isF125: boolean;
  hasSessionTypes: boolean;
  sessionLapCounts: Map<number, number>;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
  deleting: boolean;
  handleBulkDelete: () => void;
  sortBy: "time" | "lap" | "date";
  sortAsc: boolean;
  handleSort: (column: "time" | "lap" | "date") => void;
}

export function LapManagement(props: LapManagementProps) {
  const {
    track,
    gameId,
    trackLaps,
    filteredLaps,
    uniqueCars,
    uniqueDivisions,
    hasForzaTunes,
    hideClassCol,
    selectedDivision,
    setSelectedDivision,
    selectedCars,
    setSelectedCars,
    toggleCar,
    selectedLaps,
    setSelectedLaps,
    toggleLapSelect,
    toggleAllLaps,
    sectorCount,
    isF125,
    hasSessionTypes,
    sessionLapCounts,
    confirmDelete,
    setConfirmDelete,
    deleting,
    handleBulkDelete,
    sortBy,
    sortAsc,
    handleSort,
  } = props;
  const navTo = useNavigate();
  const [carouselEl, setCarouselEl] = useState<HTMLDivElement | null>(null);
  const [carouselPage, setCarouselPage] = useState(0);
  const [carouselHeight, setCarouselHeight] = useState<number | null>(null);
  const gotoCarouselPage = useCallback(
    (i: number) => {
      if (!carouselEl) return;
      carouselEl.scrollTo({ left: carouselEl.clientWidth * i, behavior: "smooth" });
      setCarouselPage(i);
    },
    [carouselEl],
  );
  useEffect(() => {
    if (!carouselEl) return;
    const page = carouselEl.children[carouselPage] as HTMLElement | undefined;
    if (!page) return;
    const update = () => setCarouselHeight(page.scrollHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(page);
    return () => ro.disconnect();
  }, [carouselEl, carouselPage]);
  useEffect(() => {
    if (!carouselEl) return;
    const onScroll = () => setCarouselPage(Math.round(carouselEl.scrollLeft / carouselEl.clientWidth));
    carouselEl.addEventListener("scroll", onScroll, { passive: true });
    return () => carouselEl.removeEventListener("scroll", onScroll);
  }, [carouselEl]);
  return (
    <div className="flex flex-col gap-3 @5xl/workspace:h-full @5xl/workspace:overflow-hidden">
      <div className="flex flex-col gap-3 @5xl/workspace:h-full @5xl/workspace:overflow-hidden">
        {(() => {
          const filterRow = (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-app-label text-app-text-muted uppercase tracking-wider">
                {m.label_laps()} ({filteredLaps.length})
              </div>
              {/* Division filter — Forza only */}
              {hasForzaTunes && uniqueDivisions.length > 1 && (
                <SearchMultiSelect<string>
                  mode="single"
                  buttonLabel={selectedDivision ?? m.trackdetail_all_divisions()}
                  options={uniqueDivisions.map((d) => ({ key: d, label: d }))}
                  isSelected={(k) => selectedDivision === k}
                  onSelect={(k) => setSelectedDivision(k)}
                  onClear={selectedDivision ? () => setSelectedDivision(null) : undefined}
                  searchPlaceholder={m.trackdetail_search_divisions_placeholder()}
                  menuWidthClass="w-56"
                />
              )}
              <SearchMultiSelect<number>
                buttonLabel={selectedCars.size === 0 ? m.track_detail_all_cars() : `${selectedCars.size} ${selectedCars.size > 1 ? m.label_cars() : m.label_car()}`}
                options={uniqueCars.map((c) => ({ key: c.carOrdinal, label: c.carName, search: c.carName }))}
                isSelected={(k) => selectedCars.has(k)}
                onSelect={(k) => toggleCar(k)}
                onClear={
                  selectedCars.size > 0
                    ? () => {
                        setSelectedCars(new Set());
                        setSelectedLaps(new Set());
                      }
                    : undefined
                }
                searchPlaceholder={m.trackdetail_search_cars_placeholder()}
                menuAlign="right"
                renderItem={(opt) => {
                  const car = uniqueCars.find((c) => c.carOrdinal === opt.key);
                  return (
                    <>
                      {!hideClassCol && car && (
                        <span className="font-bold font-mono text-app-caption flex-shrink-0" style={{ color: carClassColor(car.carClass) }}>
                          {car.carClass}
                        </span>
                      )}
                      <span className="truncate">{opt.label}</span>
                    </>
                  );
                }}
              />
              {/* Selection actions — inline in header row */}
              {selectedLaps.size > 0 && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-app-compact text-app-text-dim">
                    {selectedLaps.size} {m.trackdetail_selected()}
                  </span>
                  {selectedLaps.size === 2 &&
                    (() => {
                      const [lapA, lapB] = Array.from(selectedLaps);
                      return (
                        <Button
                          type="button"
                          onClick={() =>
                            navTo({
                              to: `${getGameRoute(gameId ?? "")}/compare`,
                              search: {
                                track: track.ordinal,
                                lapA,
                                lapB,
                                carA: trackLaps.find((l) => l.lapId === lapA)?.carOrdinal,
                                carB: trackLaps.find((l) => l.lapId === lapB)?.carOrdinal,
                              },
                            })
                          }
                          className="text-app-compact px-2 py-0.5 rounded bg-app-accent hover:bg-app-accent-hover text-app-on-filled font-medium"
                        >
                          {m.trackdetail_compare()}
                        </Button>
                      );
                    })()}
                  {!confirmDelete ? (
                    <Button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="text-app-compact px-2 py-0.5 rounded bg-status-danger/80 hover:bg-status-danger text-app-on-filled font-medium"
                    >
                      {m.trackdetail_delete()} ({selectedLaps.size})
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="text-app-compact text-status-danger">{m.trackdetail_confirm()}</span>
                      <Button
                        type="button"
                        onClick={handleBulkDelete}
                        disabled={deleting}
                        className="text-app-compact px-2 py-0.5 rounded bg-status-danger hover:bg-status-danger-hover text-app-on-filled font-medium disabled:opacity-50"
                      >
                        {deleting ? "..." : m.trackdetail_yes()}
                      </Button>
                      <Button type="button" onClick={() => setConfirmDelete(false)} className="text-app-compact px-2 py-0.5 rounded bg-app-surface-alt text-app-text-secondary hover:text-app-text">
                        {m.common_cancel()}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          return (
            <>
              {/* Desktop filter row */}
              <div className="hidden @3xl/workspace:block">{filterRow}</div>

              {/* Mobile: filter + 2-page carousel (stats / laps) */}
              <div className="flex flex-col gap-2 @3xl/workspace:hidden">
                {filterRow}
                <div className="flex items-center gap-1 border-b border-app-border">
                  {[m.trackdetail_stats_page(), m.label_laps()].map((label, i) => (
                    <Button
                      type="button"
                      key={label}
                      onClick={() => gotoCarouselPage(i)}
                      className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 -mb-px transition-colors ${carouselPage === i ? "border-app-accent text-app-accent" : "border-transparent text-app-text-muted"}`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <div
                  ref={setCarouselEl}
                  className="overflow-x-auto overflow-y-hidden snap-x snap-mandatory flex scroll-smooth items-start"
                  style={carouselHeight ? { height: carouselHeight } : undefined}
                >
                  <div className="snap-center shrink-0 w-full">
                    <LapStatsPanel laps={filteredLaps} sectorCount={sectorCount} showSessionFilter={isF125} />
                  </div>
                  <div className="snap-center shrink-0 w-full flex flex-col gap-2">
                    {(() => {
                      const paceLaps = filteredLaps.filter((lap) => isTimedLapEligibilityUsable(lap));
                      const fastestTime = paceLaps.length > 0 ? Math.min(...paceLaps.map((lap) => lap.lapTime)) : null;
                      if (filteredLaps.length === 0) {
                        return <div className="px-3 py-6 text-center text-sm text-app-text-dim">{m.track_detail_no_laps_match_filters()}</div>;
                      }
                      return filteredLaps.map((lap) => {
                        const isFastest = fastestTime !== null && lap.lapTime === fastestTime && isTimedLapEligibilityUsable(lap);
                        const selected = selectedLaps.has(lap.lapId);
                        return (
                          <div key={lap.lapId} className={`rounded-lg border border-app-border p-3 ${selected ? "bg-app-accent/5 border-app-accent/30" : ""}`}>
                            <div className="flex items-start gap-3">
                              <input type="checkbox" checked={selected} onChange={() => toggleLapSelect(lap.lapId)} className="accent-app-accent w-5 h-5 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-semibold text-app-text break-words">{lap.carName}</div>
                                    <div className="mt-0.5 flex items-center gap-2 text-xs text-app-text-muted">
                                      {!hideClassCol && (
                                        <span>
                                          <span className="font-bold font-mono" style={{ color: carClassColor(lap.carClass) }}>
                                            {lap.carClass}
                                          </span>
                                          <span className="ml-1">PI {lap.pi}</span>
                                        </span>
                                      )}
                                      <span className="font-mono">Lap {lap.lapNumber}</span>
                                      {hasSessionTypes &&
                                        lap.sessionId != null &&
                                        ((sessionLapCounts.get(lap.sessionId) ?? 0) > 1 ? (
                                          <span className="text-app-caption text-status-success font-medium">{m.track_detail_race()}</span>
                                        ) : (
                                          <span className="text-app-caption text-status-warning font-medium">{m.track_detail_quali()}</span>
                                        ))}
                                    </div>
                                    {lap.createdAt && (
                                      <div className="mt-1 text-app-compact text-app-text-dim font-mono">
                                        {new Date(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                                        {new Date(lap.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                      </div>
                                    )}
                                    {lap.notes && <div className="mt-1 text-xs text-app-text-secondary truncate">{lap.notes}</div>}
                                  </div>
                                  <div className="shrink-0 flex flex-col items-end gap-1 font-mono tabular-nums text-sm leading-tight">
                                    <div className="flex items-center gap-1">
                                      <span className={isFastest ? "font-bold" : undefined} style={{ color: isFastest ? "var(--lap-record)" : "var(--app-text)" }}>
                                        {formatLapTime(lap.lapTime)}
                                      </span>
                                      <LapStatus lap={lap} presentation="compact" />
                                      <LapQualityBadge lap={lap} policyId="corner-trace" />
                                    </div>
                                    {Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`).map((label, index) => (
                                      <div key={label} className="flex items-center gap-1">
                                        <span>{lap.sectorTimes?.[index] != null ? formatLapTime(lap.sectorTimes[index]) : "—"}</span>
                                        <span className="w-6 text-center">{label}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>

              {/* Desktop: stats + table side-by-side */}
              <div className="hidden min-h-0 flex-1 gap-3 overflow-hidden @3xl/workspace:flex">
                <LapStatsPanel laps={filteredLaps} sectorCount={sectorCount} showSessionFilter={isF125} />
                {/* Lap table (md+) */}
                <div className="flex-1 min-w-0 overflow-y-auto">
                  <Table fit>
                    <THead>
                      <TH>
                        <input type="checkbox" checked={selectedLaps.size === filteredLaps.length && filteredLaps.length > 0} onChange={toggleAllLaps} className="accent-app-accent" />
                      </TH>
                      <TH>{m.label_car()}</TH>
                      {!hideClassCol && <TH>{m.track_detail_class()}</TH>}
                      {hasSessionTypes && <TH>{m.label_type()}</TH>}
                      <SortableTH direction={sortBy === "lap" ? (sortAsc ? "ascending" : "descending") : undefined} nowrap onSort={() => handleSort("lap")}>
                        {m.track_detail_lap_num()}
                      </SortableTH>
                      <SortableTH align="end" direction={sortBy === "time" ? (sortAsc ? "ascending" : "descending") : undefined} nowrap onSort={() => handleSort("time")}>
                        {m.label_time()}
                      </SortableTH>
                      <TH />
                      {Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`).map((label) => (
                        <TH key={label}>{label}</TH>
                      ))}
                      <SortableTH direction={sortBy === "date" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("date")}>
                        {m.sessions_col_date()}
                      </SortableTH>
                      <TH>{m.sessions_col_notes()}</TH>
                    </THead>
                    <TBody>
                      {(() => {
                        const paceLaps = filteredLaps.filter((lap) => isTimedLapEligibilityUsable(lap));
                        const fastestTime = paceLaps.length > 0 ? Math.min(...paceLaps.map((lap) => lap.lapTime)) : null;
                        return filteredLaps.map((lap) => {
                          const isFastest = fastestTime !== null && lap.lapTime === fastestTime && isTimedLapEligibilityUsable(lap);
                          return (
                            <TRow key={lap.lapId} data-testid={`track-lap-${lap.lapId}`} selected={selectedLaps.has(lap.lapId)}>
                              <TD>
                                <input type="checkbox" checked={selectedLaps.has(lap.lapId)} onChange={() => toggleLapSelect(lap.lapId)} className="accent-app-accent" />
                              </TD>
                              <TD truncate="wide">{lap.carName}</TD>
                              {!hideClassCol && (
                                <TD>
                                  <span className="font-bold font-mono" style={{ color: carClassColor(lap.carClass) }}>
                                    {lap.carClass}
                                  </span>
                                  <span className="text-app-text-secondary ml-1">PI {lap.pi}</span>
                                </TD>
                              )}
                              {hasSessionTypes && (
                                <TD>
                                  {lap.sessionId != null && (sessionLapCounts.get(lap.sessionId) ?? 0) > 1 ? (
                                    <span className="text-app-caption text-status-success font-medium">{m.track_detail_race()}</span>
                                  ) : (
                                    <span className="text-app-caption text-status-warning font-medium">{m.track_detail_quali()}</span>
                                  )}
                                </TD>
                              )}
                              <TD numeric nowrap>
                                {lap.lapNumber}
                              </TD>
                              <TD align="end" nowrap>
                                <div className="flex items-center justify-end gap-1">
                                  <span className={`font-mono tabular-nums ${isFastest ? "font-bold" : ""}`} style={{ color: isFastest ? "var(--lap-record)" : undefined }}>
                                    {formatLapTime(lap.lapTime)}
                                  </span>
                                  <LapStatus lap={lap} presentation="compact" />
                                  <LapQualityBadge lap={lap} policyId="corner-trace" />
                                </div>
                              </TD>
                              <TD nowrap>
                                <Button
                                  variant="app-outline"
                                  size="app-sm"
                                  className="bg-app-accent/10 !border-app-accent/40 text-app-accent hover:bg-app-accent/20"
                                  title={m.trackdetail_analyse()}
                                  onClick={() => {
                                    if (!gameId) return;
                                    navTo({ to: `${getGameRoute(gameId)}/analyse`, search: { track: track.ordinal, car: lap.carOrdinal, lap: lap.lapId } } as never);
                                  }}
                                >
                                  {m.trackdetail_analyse()}
                                </Button>
                              </TD>
                              {Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`).map((label, index) => (
                                <TD key={label} numeric tone="primary">
                                  {lap.sectorTimes?.[index] != null ? formatLapTime(lap.sectorTimes[index]) : "—"}
                                </TD>
                              ))}
                              <TD nowrap numeric>
                                {lap.createdAt
                                  ? `${new Date(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })} ${new Date(lap.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                                  : "—"}
                              </TD>
                              <TD truncate="wide" title={lap.notes ?? undefined}>
                                {lap.notes ?? ""}
                              </TD>
                            </TRow>
                          );
                        });
                      })()}
                      {filteredLaps.length === 0 && (
                        <TRow variant="separator">
                          <TD align="center" colSpan={6} tone="dim">
                            <div className="py-2">{m.track_detail_no_laps_match_filters()}</div>
                          </TD>
                        </TRow>
                      )}
                    </TBody>
                  </Table>
                </div>
              </div>
              {/* end stats+table flex */}
            </>
          );
        })()}
      </div>
    </div>
  );
}
