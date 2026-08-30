import { isPitCycleLap } from "@shared/racing/laps/pit-cycle";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { formatLapTime } from "@/components/LiveTelemetry";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/hooks/query-keys";
import { exportLapsZip } from "@/lib/lap-export";
import { bestSectorLapIds, storedLapsSectorCount } from "@/lib/lap-sectors";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameRoute } from "@/stores/game";
import { sortLaps } from "./helpers";
import { NoteCell } from "./NoteCell";
import type { SessionLapTableProps } from "./types";

type ContextMenu = { x: number; y: number; lapId: number } | null;

export function SessionLapTable({ session, laps, lapSortKey, lapSortDir, toggleLapSort, selectedLaps, toggleLapSelection }: SessionLapTableProps) {
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null);
  const sectorCount = storedLapsSectorCount(laps);
  const sectorLabels = Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`);
  const bestSectorLaps = useMemo(
    () =>
      bestSectorLapIds(
        laps.filter((lap) => lap.isValid && !isPitCycleLap(lap)),
        sectorCount,
      ),
    [laps, sectorCount],
  );
  const sortedLaps = useMemo(() => sortLaps(laps, lapSortKey, lapSortDir), [laps, lapSortKey, lapSortDir]);

  return (
    <>
      <Table layout="fixed">
        <colgroup>
          <col className="w-11" />
          <col className="w-6" />
          <col className="w-[8%]" />
          <col className="w-[22%]" />
          {sectorLabels.map((label) => (
            <col key={label} className="w-[12%]" />
          ))}
          <col />
        </colgroup>
        <THead>
          <TH />
          <TH />
          {(["lap", "time"] as const).map((field) => (
            <SortableTH key={field} direction={lapSortKey === field ? (lapSortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleLapSort(field)}>
              {field === "lap" ? m.label_lap() : m.label_time()}
            </SortableTH>
          ))}
          {sectorLabels.map((label) => (
            <TH key={label}>{label}</TH>
          ))}
          <TH>{m.sessions_col_notes()}</TH>
        </THead>
        <TBody>
          {sortedLaps.map((lap) => {
            const isBest = (session.bestLapTime ?? 0) > 0 && Math.abs(lap.lapTime - (session.bestLapTime ?? 0)) < 0.001;
            return (
              <TRow
                key={lap.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, lapId: lap.id });
                }}
              >
                <TD align="center">
                  <input type="checkbox" checked={selectedLaps.has(lap.id)} onChange={() => toggleLapSelection(lap.id)} className="accent-app-accent w-4 h-4" />
                </TD>
                <TD />
                <TD numeric tone="primary">
                  {lap.lapNumber}
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono tabular-nums ${isBest ? "text-(--lap-pace-best) font-bold" : "text-app-text/90"}`}>{formatLapTime(lap.lapTime)}</span>
                    {lap.isValid ? (
                      <span className="text-status-success text-sm">&#10003;</span>
                    ) : (
                      <span className="text-status-danger text-sm" title={lap.invalidReason}>
                        &#10007;
                      </span>
                    )}
                    <Button
                      variant="app-outline"
                      size="app-sm"
                      className="bg-app-accent/15 !border-app-accent/40 text-app-accent hover:bg-app-accent/25"
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate({ to: `${gameRoute}/analyse` as any, search: { track: session.trackOrdinal, car: session.carOrdinal, lap: lap.id } as any });
                      }}
                    >
                      {m.label_analyse()}
                    </Button>
                  </div>
                </TD>
                {sectorLabels.map((label, index) => {
                  const value = lap.sectorTimes?.[index] ?? 0;
                  return (
                    <TD key={label} numeric>
                      <span className={bestSectorLaps[index] === lap.id ? "text-(--lap-pace-best) font-bold" : "text-app-text/90"}>{value > 0 ? formatLapTime(value) : "—"}</span>
                    </TD>
                  );
                })}
                <TD>
                  <NoteCell
                    value={lap.notes ?? undefined}
                    onSave={(notes) => {
                      void client.api.laps[":id"].notes.$patch({ param: { id: String(lap.id) }, json: { notes: notes || null } });
                      void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
                    }}
                  />
                </TD>
              </TRow>
            );
          })}
        </TBody>
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
            <Button
              variant="app-ghost"
              size="app-sm"
              className="w-full !justify-start !rounded-none !px-3 !py-1.5 text-left text-app-text hover:bg-app-surface-hover"
              onClick={async () => {
                const response = await fetch(`/api/laps/${contextMenu.lapId}/recheck`, { method: "POST" });
                const data = await response.json();
                console.log("[Recheck]", data);
                await queryClient.invalidateQueries({ queryKey: queryKeys.laps });
                setContextMenu(null);
              }}
            >
              {m.sessions_recheck_validity()}
            </Button>
            <Button
              variant="app-ghost"
              size="app-sm"
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
          </div>
        </>
      )}
    </>
  );
}
