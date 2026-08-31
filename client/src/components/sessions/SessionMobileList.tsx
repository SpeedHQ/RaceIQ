import type { GameId } from "@shared/games/ids";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { formatLapTime } from "@/components/LiveTelemetry";
import { RaceResultLedger } from "@/components/race-results/RaceResultLedger";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { formatSessionType } from "./helpers";
import { MotecBadge } from "./MotecBadge";
import { NoteCell } from "./NoteCell";
import { SessionLapTable } from "./SessionLapTable";
import { SessionResultMeta } from "./SessionResultMeta";
import type { LapSortKey, SessionSelectionEvent, SortDir } from "./types";

export type SessionMobileListProps = {
  sessions: SessionMeta[];
  lapsBySession: Map<number, LapMeta[]>;
  trackNames: Record<number, string>;
  carNames: Record<number, string>;
  isLoading: boolean;
  sessionsError: boolean;
  isF1: boolean;
  gameId: GameId | null;
  emptyMessage: string;
  expandedSessions: Set<number>;
  toggleExpand: (id: number) => void;
  selectedSessions: Set<number>;
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

export function SessionMobileList({
  sessions,
  lapsBySession,
  trackNames,
  carNames,
  isLoading,
  sessionsError,
  isF1,
  gameId,
  emptyMessage,
  expandedSessions,
  toggleExpand,
  selectedSessions,
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
}: SessionMobileListProps) {
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-auto @3xl/workspace:hidden">
      {isLoading ? (
        <div className="px-3 py-8 text-center text-app-text/90">{m.common_loading()}</div>
      ) : sessionsError ? null : sessions.length === 0 ? (
        <div className="px-3 py-8 text-center text-app-text/90">{emptyMessage}</div>
      ) : (
        sessions.map((session) => {
          const isExpanded = expandedSessions.has(session.id);
          const sessionLaps = lapsBySession.get(session.id) ?? [];
          const bestTime = session.bestLapTime || (sessionLaps.length > 0 ? Math.min(...sessionLaps.map((lap) => lap.lapTime)) : 0);
          return (
            <div key={session.id} className={`rounded-lg border border-app-border bg-app-surface ${isExpanded ? "bg-app-surface-alt/40" : ""}`}>
              {/* oxlint-disable-next-line a11y/useSemanticElements: wraps checkbox and buttons */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                className="flex items-start gap-3 p-3 cursor-pointer"
                onClick={() => toggleExpand(session.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleExpand(session.id);
                  }
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedSessions.has(session.id)}
                  onChange={(event) => toggleSessionSelection(session.id, event)}
                  onClick={(event) => event.stopPropagation()}
                  className="accent-app-accent w-5 h-5 mt-0.5 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold text-app-text truncate">{trackNames[session.trackOrdinal] ?? `Track ${session.trackOrdinal}`}</div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-app-compact text-app-text/90">
                        {new Date(session.createdAt).toLocaleDateString()} {new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {session.source === "motec" && <MotecBadge />}
                      </div>
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
                  </div>
                  <div className="text-xs text-app-text/90 truncate mt-0.5">
                    {carNames[session.carOrdinal] ?? (session.carOrdinal === 0 ? "—" : `Car ${session.carOrdinal}`)}
                    {isF1 && session.sessionType && session.sessionType !== "unknown" && <> · {formatSessionType(session.sessionType)}</>}
                  </div>
                  <div className="mt-2">
                    <SessionResultMeta session={session} />
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs">
                    <span className="text-app-text/90">
                      {m.label_laps()} <span className="text-app-text font-mono tabular-nums">{session.lapCount ?? 0}</span>
                    </span>
                    <span className="text-app-text/90">
                      {m.label_best()} <span className="text-app-text font-mono tabular-nums">{bestTime ? formatLapTime(bestTime) : "—"}</span>
                    </span>
                    <span className="ml-auto text-app-text/90">{isExpanded ? "▾" : "▸"}</span>
                  </div>
                  {/* oxlint-disable-next-line a11y/noStaticElementInteractions: containment prevents card toggle */}
                  <div role="presentation" className="mt-2" onClick={(event) => event.stopPropagation()}>
                    <NoteCell value={session.notes ?? undefined} onSave={(notes) => saveSessionNotes(session.id, notes)} />
                  </div>
                </div>
              </div>
              {isExpanded && gameId && <RaceResultLedger sessionId={session.id} gameId={gameId} enabled={isExpanded} />}
              {isExpanded && sessionLaps.length > 0 && (
                <div className="border-t border-app-border overflow-x-auto">
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
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
