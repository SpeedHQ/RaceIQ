import { Fragment } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { formatLapTime } from "@/components/LiveTelemetry";
import { RaceResultLedger } from "@/components/race-results/RaceResultLedger";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { FavoriteToggleButton } from "../FavoriteToggleButton";
import { Button } from "@/components/ui/button";
import { sessionCarName, sessionTrackName } from "./helpers";
import { SessionTypeBadge } from "./SessionTypeBadge";
import { NoteCell } from "./NoteCell";
import { MotecBadge } from "./MotecBadge";
import { SessionLapTable } from "./SessionLapTable";
import { SessionResultMeta } from "./SessionResultMeta";
import type { LapSortKey, SessionSelectionEvent, SortDir, SortKey } from "./types";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";
import { parseUtcTimestamp } from "@/lib/utc-date";

export type SessionDesktopTableProps = {
  lapsBySession: Map<number, LapMeta[]>;
  trackNames: Record<number, string>;
  carNames: Record<number, string>;
  isLoading: boolean;
  sessionsError: boolean;
  showSessionType: boolean;
  gameId: GameId | null;
  emptyMessage: string;
  colCount: number;
  pageItems: SessionMeta[];
  sortKey: SortKey;
  sortDir: SortDir;
  toggleSort: (key: SortKey) => void;
  expandedSessions: Set<number>;
  toggleExpand: (id: number) => void;
  selectedSessions: Set<number>;
  setSelectedSessions: React.Dispatch<React.SetStateAction<Set<number>>>;
  toggleSessionSelection: (id: number, event: SessionSelectionEvent) => void;
  selectedLaps: Set<number>;
  toggleLapSelection: (id: number) => void;
  sectorCount: number;
  lapSortKey: LapSortKey;
  lapSortDir: SortDir;
  toggleLapSort: (key: LapSortKey) => void;
  saveSessionNotes: (id: number, notes: string) => void;
  setRecapSessionId: (id: number) => void;
  analyseSession: (session: SessionMeta) => void;
};

export function SessionDesktopTable({
  lapsBySession,
  trackNames,
  carNames,
  isLoading,
  sessionsError,
  showSessionType,
  gameId,
  emptyMessage,
  colCount,
  pageItems,
  sortKey,
  sortDir,
  toggleSort,
  expandedSessions,
  toggleExpand,
  selectedSessions,
  setSelectedSessions,
  toggleSessionSelection,
  selectedLaps,
  toggleLapSelection,
  sectorCount,
  lapSortKey,
  lapSortDir,
  toggleLapSort,
  saveSessionNotes,
  setRecapSessionId,
  analyseSession,
}: SessionDesktopTableProps) {
  return (
    <div className="hidden flex-1 overflow-auto @3xl/workspace:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <input
                type="checkbox"
                checked={pageItems.length > 0 && pageItems.every((session) => selectedSessions.has(session.id))}
                onChange={() => {
                  const allSelected = pageItems.every((session) => selectedSessions.has(session.id));
                  setSelectedSessions((previous) => {
                    const next = new Set(previous);
                    for (const session of pageItems) {
                      if (allSelected) next.delete(session.id);
                      else next.add(session.id);
                    }
                    return next;
                  });
                }}
                className="accent-app-accent w-4 h-4"
              />
            </TableHead>
            {(
              [
                ["date", m.sessions_col_date()],
                ["laps", m.label_laps()],
                ["best", m.sessions_col_best_lap()],
                ["track", m.label_track()],
                ["car", m.label_car()],
                ["result", m.label_result()],
                ...(showSessionType ? [["type", m.label_type()] as const] : []),
              ] as const
            ).map(([field, label]) => (
              <SortableTableHead key={field} direction={sortKey === field ? (sortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleSort(field)}>
                {label}
              </SortableTableHead>
            ))}
            <TableHead>{m.sessions_col_notes()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow className="hover:bg-transparent">
              <TableCell className="text-center text-app-label" colSpan={colCount}>
                <div className="py-6">{m.common_loading()}</div>
              </TableCell>
            </TableRow>
          ) : sessionsError ? null : pageItems.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell className="text-center text-app-label" colSpan={colCount}>
                <div className="py-6">{emptyMessage}</div>
              </TableCell>
            </TableRow>
          ) : (
            pageItems.map((session) => {
              const isExpanded = expandedSessions.has(session.id);
              const sessionLaps = lapsBySession.get(session.id) ?? [];
              const bestTime = session.bestLapTime || (sessionLaps.length > 0 ? Math.min(...sessionLaps.map((lap) => lap.lapTime)) : 0);
              return (
                <Fragment key={session.id}>
                  <TableRow onClick={() => toggleExpand(session.id)} data-state={isExpanded ? "selected" : undefined} className={isExpanded && sessionLaps.length > 0 ? "border-b-0" : undefined}>
                    <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={selectedSessions.has(session.id)} onChange={(event) => toggleSessionSelection(session.id, event)} className="accent-app-accent w-4 h-4" />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-app-label">
                      <div className="flex items-center gap-2">
                        <span>
                          {parseUtcTimestamp(session.createdAt).toLocaleDateString(getLocale())}{" "}
                          <span className="text-app-text/90">{parseUtcTimestamp(session.createdAt).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })}</span>
                        </span>
                        {session.source === "motec" && <MotecBadge />}
                        <FavoriteToggleButton target="session" id={session.id} isFavorite={Boolean(session.isFavorite)} />
                        <Button
                          variant="app-outline"
                          size="app-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRecapSessionId(session.id);
                          }}
                        >
                          Recap
                        </Button>
                        <Button
                          variant="app-primary"
                          size="app-sm"
                          disabled={session.telemetryAvailable === false}
                          title={session.telemetryAvailable === false ? m.sessions_raw_telemetry_removed() : undefined}
                          onClick={(event) => {
                            event.stopPropagation();
                            analyseSession(session);
                          }}
                        >
                          {m.sessions_analyse_session()}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-app-label">{session.lapCount ?? 0}</TableCell>
                    <TableCell className="font-mono tabular-nums text-app-label">{bestTime ? formatLapTime(bestTime) : "—"}</TableCell>
                    <TableCell className="text-app-label">{sessionTrackName(session, { trackNames, carNames })}</TableCell>
                    <TableCell className="text-app-label">{sessionCarName(session, { trackNames, carNames })}</TableCell>
                    <TableCell className="text-app-label">
                      <SessionResultMeta session={session} />
                    </TableCell>
                    {showSessionType && <TableCell className="text-app-label"><SessionTypeBadge type={session.sessionType} /></TableCell>}
                    <TableCell>
                      <NoteCell value={session.notes ?? undefined} onSave={(notes) => saveSessionNotes(session.id, notes)} />
                    </TableCell>
                  </TableRow>
                  {isExpanded && gameId && (
                    <TableRow className={sessionLaps.length > 0 ? "border-b-0 hover:bg-transparent" : "hover:bg-transparent"}>
                      <TableCell colSpan={colCount} className={sessionLaps.length > 0 ? "[&>section]:border-b-0 [&>div]:border-b-0" : undefined}>
                        <RaceResultLedger sessionId={session.id} gameId={gameId} enabled={isExpanded} />
                      </TableCell>
                    </TableRow>
                  )}
                  {isExpanded && sessionLaps.length > 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={colCount} className="p-0 max-w-0">
                        <div className="bg-transparent [&>[data-slot=table-container]]:rounded-none [&>[data-slot=table-container]]:border-0 [&_[data-slot=table-head]]:bg-transparent">
                          <SessionLapTable
                            session={session}
                            laps={sessionLaps}
                            sectorCount={sectorCount}
                            lapSortKey={lapSortKey}
                            lapSortDir={lapSortDir}
                            toggleLapSort={toggleLapSort}
                            selectedLaps={selectedLaps}
                            toggleLapSelection={toggleLapSelection}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
