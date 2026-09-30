import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { F125Leaderboard } from "@/components/f1/F125Leaderboard";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SearchMultiSelect } from "@/components/ui/SearchMultiSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { getGameRoute } from "@/stores/game";
import { parseUtcTimestamp } from "@/lib/utc-date";
import type { TrackInfo } from "../types";
import { CommunityLeaderboard } from "../CommunityLeaderboard";
import { carClassColor } from "./helpers";
import { LapStatsPanel } from "./LapStatsPanel";
import type { TrackLap, TrackLapSortKey } from "./types";

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
  sortBy: TrackLapSortKey;
  sortAsc: boolean;
  handleSort: (column: TrackLapSortKey) => void;
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
  const [referenceTab, setReferenceTab] = useState("stats");
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
  const selectedCarNames = useMemo(
    () => uniqueCars.filter((car) => selectedCars.has(car.carOrdinal)).map((car) => car.carName),
    [uniqueCars, selectedCars],
  );
  const leaderboard = isF125
    ? <F125Leaderboard trackOrdinal={track.ordinal} />
    : <CommunityLeaderboard trackName={track.name} trackVariant={track.variant} selectedCarNames={selectedCarNames} />;
  const referenceContent = (
    <>
      <TabsContent value="stats" className="min-h-0 @3xl/workspace:flex-1 @3xl/workspace:overflow-hidden">
        <LapStatsPanel laps={filteredLaps.filter((l) => l.isValid !== false)} sectorCount={sectorCount} showSessionFilter={isF125} />
      </TabsContent>
      <TabsContent value="community" className="flex h-[400px] min-h-0 flex-col overflow-hidden @3xl/workspace:h-auto @3xl/workspace:flex-1">
        {leaderboard}
      </TabsContent>
    </>
  );
  const referencePanel = (
    <Tabs value={referenceTab} onValueChange={setReferenceTab} className="flex h-full min-h-0 flex-col gap-3 @3xl/workspace:row-span-2 @3xl/workspace:grid @3xl/workspace:grid-rows-subgrid">
      <TabsList className="shrink-0">
        <TabsTrigger value="stats">{m.track_detail_stats()}</TabsTrigger>
        <TabsTrigger value="community">{m.leaderboard_community()}</TabsTrigger>
      </TabsList>
      {referenceContent}
    </Tabs>
  );
  return (
    <div className="flex flex-col gap-3 @3xl/workspace:h-full @3xl/workspace:min-h-0 @3xl/workspace:overflow-hidden">
      <div className="flex flex-col gap-3 @3xl/workspace:h-full @3xl/workspace:min-h-0 @3xl/workspace:overflow-hidden">
        {(() => {
          const selectionActions = selectedLaps.size > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
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
          );
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
            </div>
          );
          return (
            <>
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
                    {referencePanel}
                  </div>
                  <div className="snap-center shrink-0 w-full flex flex-col gap-2">
                    {selectionActions}
                    {(() => {
                      const validLaps = filteredLaps.filter((l) => l.isValid !== false);
                      const fastestTime = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
                      if (filteredLaps.length === 0) {
                        return <div className="px-3 py-6 text-center text-sm text-app-text-dim">{m.track_detail_no_laps_match_filters()}</div>;
                      }
                      return filteredLaps.map((lap) => {
                        const isFastest = fastestTime !== null && lap.lapTime === fastestTime && lap.isValid !== false;
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
                                        {parseUtcTimestamp(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
                                        {parseUtcTimestamp(lap.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                      </div>
                                    )}
                                    {lap.notes && <div className="mt-1 text-xs text-app-text-secondary truncate">{lap.notes}</div>}
                                  </div>
                                  <div className="shrink-0 flex flex-col items-end gap-1 font-mono tabular-nums text-sm leading-tight">
                                    <div className="flex items-center gap-1">
                                      <span className={isFastest ? "font-bold" : undefined} style={{ color: isFastest ? "var(--lap-record)" : "var(--app-text)" }}>
                                        {formatLapTime(lap.lapTime)}
                                      </span>
                                      {lap.isValid === false ? (
                                        <span className="text-status-danger w-6 text-center" title={lap.invalidReason ?? m.trackdetail_invalid_lap()}>
                                          ✕
                                        </span>
                                      ) : (
                                        <span className="text-status-success w-6 text-center">✓</span>
                                      )}
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

              {/* Desktop: shared filters / tabs header; reference left, lap list right */}
              <Tabs value={referenceTab} onValueChange={setReferenceTab} className="hidden min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden @3xl/workspace:grid">
                <div className="col-span-2 grid grid-cols-subgrid items-center gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    {filterRow}
                    <TabsList className="shrink-0">
                      <TabsTrigger value="stats">{m.track_detail_stats()}</TabsTrigger>
                      <TabsTrigger value="community">{m.leaderboard_community()}</TabsTrigger>
                    </TabsList>
                  </div>
                  <div className="flex min-h-10 items-center">
                    {selectionActions}
                  </div>
                </div>
                <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                  {referenceContent}
                </div>
                <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                  {/* Lap table */}
                  <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          <input type="checkbox" checked={selectedLaps.size === filteredLaps.length && filteredLaps.length > 0} onChange={toggleAllLaps} className="accent-app-accent" />
                        </TableHead>
                        <SortableTableHead direction={sortBy === "car" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("car")}>{m.label_car()}</SortableTableHead>
                        {!hideClassCol && <SortableTableHead direction={sortBy === "class" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("class")}>{m.track_detail_class()}</SortableTableHead>}
                        {hasSessionTypes && <SortableTableHead direction={sortBy === "type" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("type")}>{m.label_type()}</SortableTableHead>}
                        <SortableTableHead className="whitespace-nowrap" direction={sortBy === "lap" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("lap")}>
                          {m.track_detail_lap_num()}
                        </SortableTableHead>
                        <TableHead />
                        <SortableTableHead className="text-right whitespace-nowrap" direction={sortBy === "time" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("time")}>
                          {m.label_time()}
                        </SortableTableHead>
                        {Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`).map((label, index) => (
                          <SortableTableHead key={label} className="text-right" direction={sortBy === index ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort(index)}>{label}</SortableTableHead>
                        ))}
                        <SortableTableHead direction={sortBy === "date" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("date")}>
                          {m.sessions_col_date()}
                        </SortableTableHead>
                        <SortableTableHead direction={sortBy === "notes" ? (sortAsc ? "ascending" : "descending") : undefined} onSort={() => handleSort("notes")}>{m.sessions_col_notes()}</SortableTableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(() => {
                        const validLaps = filteredLaps.filter((l) => l.isValid !== false);
                        const fastestTime = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
                        return filteredLaps.map((lap) => {
                          const isFastest = fastestTime !== null && lap.lapTime === fastestTime && lap.isValid !== false;
                          return (
                            <TableRow key={lap.lapId} data-testid={`track-lap-${lap.lapId}`} data-state={selectedLaps.has(lap.lapId) ? "selected" : undefined}>
                              <TableCell>
                                <input type="checkbox" checked={selectedLaps.has(lap.lapId)} onChange={() => toggleLapSelect(lap.lapId)} className="accent-app-accent" />
                              </TableCell>
                              <TableCell className="max-w-[240px] truncate">{lap.carName}</TableCell>
                              {!hideClassCol && (
                                <TableCell>
                                  <span className="font-bold font-mono" style={{ color: carClassColor(lap.carClass) }}>{lap.carClass}</span>
                                  <span className="text-app-text-secondary ml-1">PI {lap.pi}</span>
                                </TableCell>
                              )}
                              {hasSessionTypes && (
                                <TableCell>
                                  {lap.sessionId != null && (sessionLapCounts.get(lap.sessionId) ?? 0) > 1 ? (
                                    <span className="text-app-caption text-status-success font-medium">{m.track_detail_race()}</span>
                                  ) : (
                                    <span className="text-app-caption text-status-warning font-medium">{m.track_detail_quali()}</span>
                                  )}
                                </TableCell>
                              )}
                              <TableCell className="font-mono tabular-nums whitespace-nowrap">{lap.lapNumber}</TableCell>
                              <TableCell className="whitespace-nowrap">
                                <Button
                                  variant="app-primary"
                                  size="app-sm"
                                  disabled={!gameId || lap.sessionId == null}
                                  onClick={() => {
                                    if (!gameId || lap.sessionId == null) return;
                                    navTo({ to: `${getGameRoute(gameId)}/sessions/${lap.sessionId}/replay/${lap.lapId}` } as never);
                                  }}
                                >
                                  {m.sessions_replay_lap()}
                                </Button>
                              </TableCell>
                              <TableCell className="text-right whitespace-nowrap">
                                <div className="flex items-center justify-end gap-1">
                                  <span className={`font-mono tabular-nums ${isFastest ? "font-bold" : ""}`} style={{ color: isFastest ? "var(--lap-record)" : undefined }}>
                                    {formatLapTime(lap.lapTime)}
                                  </span>
                                  {lap.isValid === false ? (
                                    <span className="group/inv relative text-sm text-status-danger cursor-default">
                                      ✕
                                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover/inv:block w-max max-w-[200px] bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-app-caption text-app-text-secondary z-50 pointer-events-none leading-relaxed">{lap.invalidReason ?? m.trackdetail_invalid_lap()}</span>
                                    </span>
                                  ) : (
                                    <span className="text-sm text-status-success">✓</span>
                                  )}
                                </div>
                              </TableCell>
                              {Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`).map((label, index) => (
                                <TableCell key={label} className="text-right font-mono tabular-nums text-app-text">
                                  {lap.sectorTimes?.[index] != null ? formatLapTime(lap.sectorTimes[index]) : "—"}
                                </TableCell>
                              ))}
                              <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                                {lap.createdAt
                                  ? `${parseUtcTimestamp(lap.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })} ${parseUtcTimestamp(lap.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                                  : "—"}
                              </TableCell>
                              <TableCell className="max-w-[240px] truncate" title={lap.notes ?? undefined}>{lap.notes ?? ""}</TableCell>
                            </TableRow>
                          );
                        });
                      })()}
                      {filteredLaps.length === 0 && (
                        <TableRow>
                          <TableCell className="text-center text-app-text-dim" colSpan={6}>
                            <div className="py-2">{m.track_detail_no_laps_match_filters()}</div>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                </div>
              </Tabs>
              {/* end stats+table flex */}
            </>
          );
        })()}
      </div>
    </div>
  );
}
