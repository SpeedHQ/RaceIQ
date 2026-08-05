import type { GameId } from "@shared/games/ids";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { Fragment } from "react";
import { formatLapTime } from "@/components/LiveTelemetry";
import { RaceResultLedger } from "@/components/race-results/RaceResultLedger";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { formatSessionType } from "./helpers";
import { NoteCell } from "./NoteCell";
import { SessionLapTable } from "./SessionLapTable";
import { SessionResultMeta } from "./SessionResultMeta";
import type { LapSortKey, SessionSelectionEvent, SortDir, SortKey } from "./types";

export type SessionDesktopTableProps = {
  lapsBySession: Map<number, LapMeta[]>;
  trackNames: Record<number, string>;
  carNames: Record<number, string>;
  isLoading: boolean;
  sessionsError: boolean;
  isF1: boolean;
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
  exporting: boolean;
  runExport: (selection: { sessionIds?: number[] }) => void;
  setRecapSessionId: (id: number) => void;
};

export function SessionDesktopTable({
  lapsBySession,
  trackNames,
  carNames,
  isLoading,
  sessionsError,
  isF1,
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
  exporting,
  runExport,
  setRecapSessionId,
}: SessionDesktopTableProps) {
  return (
    <div className="hidden flex-1 overflow-auto @3xl/workspace:block">
      <Table fit>
        <THead>
          <TH>
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
          </TH>
          {(
            [
              ["date", m.sessions_col_date()],
              ["laps", m.label_laps()],
              ["best", m.sessions_col_best_lap()],
              ["track", m.label_track()],
              ["car", m.label_car()],
              ["result", "Result"],
              ...(isF1 ? [["type", m.label_type()] as const] : []),
            ] as const
          ).map(([field, label]) => (
            <SortableTH key={field} direction={sortKey === field ? (sortDir === "asc" ? "ascending" : "descending") : undefined} onSort={() => toggleSort(field)}>
              {label}
            </SortableTH>
          ))}
          <TH>{m.sessions_col_notes()}</TH>
        </THead>
        <TBody>
          {isLoading ? (
            <TRow variant="separator">
              <TD align="center" colSpan={colCount} tone="primary">
                <div className="py-6">{m.common_loading()}</div>
              </TD>
            </TRow>
          ) : sessionsError ? null : pageItems.length === 0 ? (
            <TRow variant="separator">
              <TD align="center" colSpan={colCount} tone="primary">
                <div className="py-6">{emptyMessage}</div>
              </TD>
            </TRow>
          ) : (
            pageItems.map((session) => {
              const isExpanded = expandedSessions.has(session.id);
              const sessionLaps = lapsBySession.get(session.id) ?? [];
              const bestTime = session.bestLapTime || (sessionLaps.length > 0 ? Math.min(...sessionLaps.map((lap) => lap.lapTime)) : 0);
              return (
                <Fragment key={session.id}>
                  <TRow onClick={() => toggleExpand(session.id)} selected={isExpanded}>
                    <TD align="center" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={selectedSessions.has(session.id)} onChange={(event) => toggleSessionSelection(session.id, event)} className="accent-app-accent w-4 h-4" />
                    </TD>
                    <TD nowrap tone="primary">
                      <div className="flex items-center gap-2">
                        <span>
                          {new Date(session.createdAt).toLocaleDateString()}{" "}
                          <span className="text-app-text/90">{new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        </span>
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
                          variant="app-outline"
                          size="app-sm"
                          disabled={exporting}
                          title={m.sessions_export_session()}
                          onClick={(event) => {
                            event.stopPropagation();
                            runExport({ sessionIds: [session.id] });
                          }}
                        >
                          {m.label_export()}
                        </Button>
                      </div>
                    </TD>
                    <TD numeric tone="primary">
                      {session.lapCount ?? 0}
                    </TD>
                    <TD numeric tone="primary">
                      {bestTime ? formatLapTime(bestTime) : "—"}
                    </TD>
                    <TD tone="primary">{trackNames[session.trackOrdinal] ?? `Track ${session.trackOrdinal}`}</TD>
                    <TD tone="primary">{carNames[session.carOrdinal] ?? (session.carOrdinal === 0 ? "—" : `Car ${session.carOrdinal}`)}</TD>
                    <TD tone="primary">
                      <SessionResultMeta session={session} />
                    </TD>
                    {isF1 && <TD tone="primary">{formatSessionType(session.sessionType)}</TD>}
                    <TD>
                      <NoteCell value={session.notes ?? undefined} onSave={(notes) => saveSessionNotes(session.id, notes)} />
                    </TD>
                  </TRow>
                  {isExpanded && gameId && (
                    <TRow variant="separator">
                      <TD colSpan={colCount}>
                        <RaceResultLedger sessionId={session.id} gameId={gameId} enabled={isExpanded} />
                      </TD>
                    </TRow>
                  )}
                  {isExpanded && sessionLaps.length > 0 && (
                    <TRow variant="separator">
                      <TD colSpan={colCount}>
                        <div className="bg-app-surface-alt/20 border-b border-app-border pl-8">
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
                      </TD>
                    </TRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TBody>
      </Table>
    </div>
  );
}
