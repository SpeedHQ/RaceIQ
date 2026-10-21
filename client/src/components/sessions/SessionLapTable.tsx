import { isPaceLap } from "@raceiq/shared/racing/lap-classification"
import { isPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle"
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { formatLapTime } from "@/components/LiveTelemetry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/hooks/query-keys";
import { bestSectorLapIds } from "@/lib/lap-sectors";
import { authenticatedFetch, client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { exportLapsZip } from "@/lib/lap-export";
import { useGameRoute } from "@/stores/game";
import { sortLaps } from "./helpers";
import { NoteCell } from "./NoteCell";
import type { SessionLapTableProps } from "./types";
import { FavoriteToggleButton } from "../FavoriteToggleButton";

type ContextMenu = { x: number; y: number; lapId: number } | null;

export function SessionLapTable({ session, laps, sectorCount, lapSortKey, lapSortDir, toggleLapSort, selectedLaps, toggleLapSelection }: SessionLapTableProps) {
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [contextMenu, setContextMenu] = useState<ContextMenu>(null);
  const sessionType = session.sessionType?.trim();
  const sessionTypeLabel = sessionType && sessionType.toLowerCase() !== "unknown"
    ? sessionType.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : m.common_unknown();
  const sectorLabels = Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`);
  const classificationLabels = {
    pace: m.sessions_lap_classification_pace(),
    out_lap: m.sessions_lap_classification_out_lap(),
    in_lap: m.sessions_lap_classification_in_lap(),
    pit_lap: m.sessions_lap_classification_pit_lap(),
    grid_start: m.sessions_lap_classification_grid_start(),
    caution: m.sessions_lap_classification_caution(),
    reset: m.sessions_lap_classification_reset(),
  };
  const bestSectorLaps = useMemo(
    () =>
      bestSectorLapIds(
        laps.filter((lap) => lap.isValid && isPaceLap(lap.classification) && !isPitCycleLap(lap)),
        sectorCount,
      ),
    [laps, sectorCount],
  );
  const contextLap = contextMenu ? laps.find((lap) => lap.id === contextMenu.lapId) : undefined;
  const sortedLaps = useMemo(() => sortLaps(laps, lapSortKey, lapSortDir), [laps, lapSortKey, lapSortDir]);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-11 min-w-11 max-w-11" />
            <SortableTableHead className="w-1 min-w-10 pr-1" direction={lapSortKey === "lap" ? (lapSortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleLapSort("lap")}>
              {m.label_lap()}
            </SortableTableHead>
            <TableHead className="w-1 pl-1" />
            <SortableTableHead className="w-1 min-w-32" direction={lapSortKey === "time" ? (lapSortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleLapSort("time")}>
              {m.label_time()}
            </SortableTableHead>
            <TableHead className="w-1 min-w-28">{m.review_session()}</TableHead>
            <TableHead className="w-1 min-w-28">{m.sessions_col_classification()}</TableHead>
            {sectorLabels.map((label, index) => (
              <SortableTableHead key={label} className="w-1 min-w-24 text-right" direction={lapSortKey === index ? (lapSortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleLapSort(index)}>
                {label}
              </SortableTableHead>
            ))}
            <SortableTableHead className="w-auto min-w-40" direction={lapSortKey === "notes" ? (lapSortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleLapSort("notes")}>
              {m.sessions_col_notes()}
            </SortableTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedLaps.map((lap) => {
            const isBest = (session.bestLapTime ?? 0) > 0 && Math.abs(lap.lapTime - (session.bestLapTime ?? 0)) < 0.001;
            return (
              <TableRow
                key={lap.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, lapId: lap.id });
                }}
              >
                <TableCell className="w-11 min-w-11 max-w-11 text-center whitespace-nowrap">
                  <input type="checkbox" checked={selectedLaps.has(lap.id)} onChange={() => toggleLapSelection(lap.id)} className="accent-app-accent w-4 h-4" />
                </TableCell>
                <TableCell className="w-1 min-w-10 pr-1 font-mono tabular-nums text-app-label whitespace-nowrap">{lap.lapNumber}</TableCell>
                <TableCell className="w-1 pl-1 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <FavoriteToggleButton target="lap" id={lap.id} isFavorite={Boolean(lap.isFavorite)} />
                    <Button
                      variant="app-primary"
                      size="app-sm"
                      disabled={lap.telemetryAvailable === false}
                      title={lap.telemetryAvailable === false ? m.sessions_raw_telemetry_removed() : undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate({ to: `${gameRoute}/sessions/${lap.sessionId}/replay/${lap.id}` as never });
                      }}
                    >
                      {m.sessions_replay_lap()}
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="w-1 min-w-32 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono tabular-nums ${isBest ? "text-(--lap-pace-best) font-bold" : "text-app-text/90"}`}>{formatLapTime(lap.lapTime)}</span>
                    {lap.isValid ? (
                      <span className="text-status-success text-sm">&#10003;</span>
                    ) : (
                      <span className="text-status-danger text-sm" title={lap.invalidReason}>
                        &#10007;
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="w-1 min-w-28 whitespace-nowrap text-app-label text-app-text-secondary">
                  {sessionTypeLabel}
                </TableCell>
                <TableCell className="w-1 min-w-28 whitespace-nowrap text-app-label text-app-text-secondary">
                  {lap.classification != null
                    ? classificationLabels[lap.classification]
                    : !lap.isValid && (lap.invalidReason === "incomplete" || lap.invalidReason === "incomplete at end of input")
                      ? m.sessions_lap_classification_incomplete()
                      : m.sessions_lap_classification_unclassified()}
                </TableCell>
                {sectorLabels.map((label, index) => {
                  const value = lap.sectorTimes?.[index] ?? 0;
                  return (
                    <TableCell key={label} className="w-1 min-w-24 text-right font-mono tabular-nums whitespace-nowrap">
                      <span className={bestSectorLaps[index] === lap.id ? "text-(--lap-pace-best) font-bold" : "text-app-text/90"}>{value > 0 ? formatLapTime(value) : "—"}</span>
                    </TableCell>
                  );
                })}
                <TableCell className="w-auto min-w-40 whitespace-normal">
                  <NoteCell
                    value={lap.notes ?? undefined}
                    onSave={(notes) => {
                      void client.api.laps[":id"].notes.$patch({ param: { id: String(lap.id) }, json: { notes: notes || null } });
                      void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {contextMenu && (
        <>
          <Button
            type="button"
            aria-label={m.common_close()}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div className="fixed z-50 bg-app-surface border border-app-border rounded shadow-lg py-1 text-sm" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {contextLap?.telemetryAvailable !== false && (
              <>
            <Button
              variant="app-ghost"
              size="app-sm"
              disabled={false}
              title={undefined}
              className="w-full !justify-start !rounded-none !px-3 !py-1.5 text-left text-app-text hover:bg-app-surface-hover"
              onClick={async () => {
                const response = await authenticatedFetch(`/api/laps/${contextMenu.lapId}/recheck`, { method: "POST" });
                const data = await response.json();
                console.log("[Recheck]", data);
                await queryClient.invalidateQueries({ queryKey: queryKeys.laps });
                await queryClient.invalidateQueries({ queryKey: queryKeys.userTunes });
                setContextMenu(null);
              }}
            >
              {m.sessions_recheck_validity()}
            </Button>
            <Button
              variant="app-ghost"
              size="app-sm"
              disabled={contextLap?.source !== "motec" && contextLap?.standaloneCaptureReady === false}
              title={contextLap?.source !== "motec" && contextLap?.standaloneCaptureReady === false ? m.sessions_export_capture_not_ready() : undefined}
              className="w-full !justify-start !rounded-none !px-3 !py-1.5 text-left text-app-text hover:bg-app-surface-hover"
              onClick={async () => {
                const lapId = contextMenu.lapId;
                setContextMenu(null);
                try {
                  await exportLapsZip({ lapIds: [lapId] });
                } catch (error) {
                  window.alert(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              {m.sessions_export_lap()}
            </Button>
            {contextLap?.source !== "motec" && contextLap?.standaloneCaptureReady === false && (
              <p className="max-w-64 px-3 py-1 text-xs text-app-text/90" role="status">{m.sessions_export_capture_not_ready()}</p>
            )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
