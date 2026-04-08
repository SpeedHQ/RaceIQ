import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { LapMeta } from "@shared/types";
import { queryKeys, useSessions, useLaps, useDeleteLap } from "../hooks/queries";
import { useActiveProfileId } from "../hooks/useProfiles";
import { useGameId, useGameRoute } from "../stores/game";
import { client } from "../lib/rpc";
import { formatLapTime } from "./LiveTelemetry";
import { SearchSelect } from "./ui/SearchSelect";
import { Button } from "./ui/button";

const PAGE_SIZE = 25;

type SortKey = "date" | "track" | "car" | "laps" | "best" | "type";
type SortDir = "asc" | "desc";

function formatSessionType(type?: string): string {
  if (!type || type === "unknown") return "";
  return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function SortHeader({ label, field, sortKey, sortDir, toggleSort }: {
  label: string; field: SortKey;
  sortKey: SortKey; sortDir: SortDir; toggleSort: (f: SortKey) => void;
}) {
  return (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-app-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-app-text"
      onClick={() => toggleSort(field)}
    >
      {label} {sortKey === field ? (sortDir === "asc" ? "▲" : "▼") : ""}
    </th>
  );
}

export function SessionsPage() {
  const gameId = useGameId();
  const gameRoute = useGameRoute();
  const { data: sessions = [], isLoading } = useSessions();
  const { data: activeProfileId } = useActiveProfileId();
  const { data: allLaps = [] } = useLaps(activeProfileId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const deleteLap = useDeleteLap();

  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [expandedSession, setExpandedSession] = useState<number | null>(null);
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  const [trackFilter, setTrackFilter] = useState("");
  const [carFilter, setCarFilter] = useState("");

  // Group laps by session
  const lapsBySession = useMemo(() => {
    const map = new Map<number, LapMeta[]>();
    for (const lap of allLaps) {
      const list = map.get(lap.sessionId) ?? [];
      list.push(lap);
      map.set(lap.sessionId, list);
    }
    return map;
  }, [allLaps]);

  // Fetch track/car names for visible sessions
  useEffect(() => {
    const trackOrds = new Set<number>();
    const carOrds = new Set<number>();
    for (const s of sessions) {
      if (s.trackOrdinal) trackOrds.add(s.trackOrdinal);
      if (s.carOrdinal) carOrds.add(s.carOrdinal);
    }
    for (const ord of trackOrds) {
      if (!trackNames[ord]) {
        client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
          .then((r) => r.ok ? r.text() : "")
          .then((name) => { if (name) setTrackNames((prev) => ({ ...prev, [ord]: name })); })
          .catch(() => {});
      }
    }
    for (const ord of carOrds) {
      if (!carNames[ord]) {
        client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
          .then((r) => r.ok ? r.text() : "")
          .then((name) => { if (name) setCarNames((prev) => ({ ...prev, [ord]: name })); })
          .catch(() => {});
      }
    }
  }, [sessions, gameId]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "best" ? "asc" : "desc");
    }
  };

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      let valA: string | number;
      let valB: string | number;
      switch (sortKey) {
        case "date":
          valA = new Date(a.createdAt).getTime();
          valB = new Date(b.createdAt).getTime();
          break;
        case "track":
          valA = trackNames[a.trackOrdinal] ?? `Track ${a.trackOrdinal}`;
          valB = trackNames[b.trackOrdinal] ?? `Track ${b.trackOrdinal}`;
          break;
        case "car":
          valA = carNames[a.carOrdinal] ?? `Car ${a.carOrdinal}`;
          valB = carNames[b.carOrdinal] ?? `Car ${b.carOrdinal}`;
          break;
        case "laps":
          valA = a.lapCount ?? 0;
          valB = b.lapCount ?? 0;
          break;
        case "best":
          valA = a.bestLapTime ?? Infinity;
          valB = b.bestLapTime ?? Infinity;
          break;
        case "type":
          valA = a.sessionType ?? "";
          valB = b.sessionType ?? "";
          break;
        default:
          return 0;
      }
      if (typeof valA === "string") {
        const cmp = valA.localeCompare(valB as string);
        return sortDir === "asc" ? cmp : -cmp;
      }
      return sortDir === "asc" ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [sessions, sortKey, sortDir, trackNames, carNames]);

  const trackOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const s of sessions) {
      if (!seen.has(s.trackOrdinal)) {
        seen.set(s.trackOrdinal, trackNames[s.trackOrdinal] ?? `Track ${s.trackOrdinal}`);
      }
    }
    return [...seen.entries()]
      .map(([ord, label]) => ({ value: String(ord), label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions, trackNames]);

  const carOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const s of sessions) {
      if (s.carOrdinal !== 0 && !seen.has(s.carOrdinal)) {
        seen.set(s.carOrdinal, carNames[s.carOrdinal] ?? `Car ${s.carOrdinal}`);
      }
    }
    return [...seen.entries()]
      .map(([ord, label]) => ({ value: String(ord), label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions, carNames]);

  const filtered = useMemo(() => {
    return sorted.filter((s) => {
      if (trackFilter && String(s.trackOrdinal) !== trackFilter) return false;
      if (carFilter && String(s.carOrdinal) !== carFilter) return false;
      return true;
    });
  }, [sorted, trackFilter, carFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [sessions.length, trackFilter, carFilter]);

  const toggleSessionSelection = useCallback((sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((sessionId: number) => {
    setExpandedSession((prev) => prev === sessionId ? null : sessionId);
    setSelectedLaps(new Set());
  }, []);

  const toggleLapSelection = useCallback((lapId: number) => {
    setSelectedLaps((prev) => {
      const next = new Set(prev);
      if (next.has(lapId)) next.delete(lapId);
      else next.add(lapId);
      return next;
    });
  }, []);

  const selectAllLaps = useCallback((sessionId: number) => {
    const laps = lapsBySession.get(sessionId) ?? [];
    setSelectedLaps((prev) => {
      const allSelected = laps.every((l) => prev.has(l.id));
      if (allSelected) return new Set();
      return new Set(laps.map((l) => l.id));
    });
  }, [lapsBySession]);

  const deleteSelected = useCallback(async () => {
    if (selectedSessions.size > 0) {
      await client.api.sessions["bulk-delete"].$post({ json: { ids: [...selectedSessions] } });
    }
    if (selectedLaps.size > 0) {
      await client.api.laps["bulk-delete"].$post({ json: { ids: [...selectedLaps] } });
    }
    setSelectedLaps(new Set());
    setSelectedSessions(new Set());
    qc.invalidateQueries({ queryKey: queryKeys.sessions });
    qc.invalidateQueries({ queryKey: queryKeys.laps });
  }, [selectedLaps, selectedSessions, qc]);

  const isF1 = gameId === "f1-2025";
  const colCount = isF1 ? 7 : 6;

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      <div className="flex items-center gap-3">
        {(selectedSessions.size > 0 || selectedLaps.size > 0) && (
          <button
            onClick={deleteSelected}
            className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors"
          >
            Delete {selectedSessions.size > 0 ? `${selectedSessions.size} session${selectedSessions.size > 1 ? "s" : ""}` : ""}{selectedSessions.size > 0 && selectedLaps.size > 0 ? " + " : ""}{selectedLaps.size > 0 ? `${selectedLaps.size} lap${selectedLaps.size > 1 ? "s" : ""}` : ""}
          </button>
        )}
        <h1 className="text-sm font-semibold text-app-text">
          Sessions
          {!isLoading && (
            <span className="text-app-text-muted font-normal ml-2">
              {filtered.length === sessions.length ? `${sessions.length} total` : `${filtered.length} of ${sessions.length}`}
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2 ml-auto">
          <SearchSelect
            value={trackFilter}
            onChange={setTrackFilter}
            options={[{ value: "", label: "All tracks" }, ...trackOptions]}
            placeholder="Filter track..."
            className="w-48"
          />
          <SearchSelect
            value={carFilter}
            onChange={setCarFilter}
            options={[{ value: "", label: "All cars" }, ...carOptions]}
            placeholder="Filter car..."
            className="w-48"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-app-border">
        <table className="w-full text-base">
          <thead className="bg-app-surface sticky top-0 z-10">
            <tr className="border-b border-app-border">
              <th className="w-8 px-2">
                <input
                  type="checkbox"
                  checked={pageItems.length > 0 && pageItems.every((s) => selectedSessions.has(s.id))}
                  onChange={() => {
                    const allSelected = pageItems.every((s) => selectedSessions.has(s.id));
                    setSelectedSessions((prev) => {
                      const next = new Set(prev);
                      for (const s of pageItems) {
                        if (allSelected) next.delete(s.id);
                        else next.add(s.id);
                      }
                      return next;
                    });
                  }}
                  className="accent-cyan-400 w-4 h-4"
                />
              </th>
              <SortHeader label="Date" field="date" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Track" field="track" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Car" field="car" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              {isF1 && <SortHeader label="Type" field="type" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />}
              <SortHeader label="Laps" field="laps" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Best Lap" field="best" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-8 text-center text-app-text-muted">
                  Loading...
                </td>
              </tr>
            ) : pageItems.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-8 text-center text-app-text-muted">
                  No sessions recorded yet
                </td>
              </tr>
            ) : (
              pageItems.map((session) => {
                const isExpanded = expandedSession === session.id;
                const sessionLaps = lapsBySession.get(session.id) ?? [];
                const sortedLaps = [...sessionLaps].sort((a, b) => a.lapNumber - b.lapNumber);
                return (
                  <>
                    <tr
                      key={session.id}
                      className={`border-b border-app-border/50 hover:bg-app-accent/5 cursor-pointer transition-colors ${isExpanded ? "bg-app-surface-alt/30" : ""}`}
                      onClick={() => toggleExpand(session.id)}
                    >
                      <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedSessions.has(session.id)}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          onChange={(e) => toggleSessionSelection(session.id, e as any)}
                          className="accent-cyan-400 w-4 h-4"
                        />
                      </td>
                      <td className="px-3 py-2 text-app-text-secondary whitespace-nowrap">
                        {new Date(session.createdAt).toLocaleDateString()}{" "}
                        <span className="text-app-text-dim">
                          {new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-app-text">
                        {trackNames[session.trackOrdinal] ?? `Track ${session.trackOrdinal}`}
                      </td>
                      <td className="px-3 py-2 text-app-text">
                        {carNames[session.carOrdinal] ?? (session.carOrdinal === 0 ? "—" : `Car ${session.carOrdinal}`)}
                      </td>
                      {isF1 && (
                        <td className="px-3 py-2 text-app-text-secondary">
                          {formatSessionType(session.sessionType)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-app-text-secondary tabular-nums">
                        {session.lapCount ?? 0}
                      </td>
                      <td className="px-3 py-2 text-app-text tabular-nums">
                        {session.bestLapTime ? formatLapTime(session.bestLapTime) : "—"}
                      </td>
                    </tr>
                    {isExpanded && sortedLaps.length > 0 && (
                      <tr key={`${session.id}-laps`}>
                        <td colSpan={colCount} className="p-0">
                          <div className="bg-app-surface-alt/20 border-b border-app-border">
                            <div className="px-4 py-1.5 flex items-center justify-between border-b border-app-border/30">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={sortedLaps.length > 0 && sortedLaps.every((l) => selectedLaps.has(l.id))}
                                  onChange={() => selectAllLaps(session.id)}
                                  className="accent-cyan-400 w-4 h-4"
                                />
                                <span className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold">
                                  {sortedLaps.length} laps
                                </span>
                              </div>
                              {selectedLaps.size > 0 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); deleteSelected(); }}
                                  className="px-2 py-0.5 text-[10px] rounded bg-red-600 hover:bg-red-500 text-white"
                                >
                                  Delete selected
                                </button>
                              )}
                            </div>
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-app-text-dim uppercase tracking-wider">
                                  <th className="w-8 px-2 py-1" />
                                  <th className="px-3 py-1 text-left">Lap</th>
                                  <th className="px-3 py-1 text-left">Time</th>
                                  <th className="px-3 py-1 text-left">Valid</th>
                                  <th className="px-3 py-1 text-right">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sortedLaps.map((lap) => {
                                  const best = session.bestLapTime ?? 0;
                                  const isBest = best > 0 && Math.abs(lap.lapTime - best) < 0.001;
                                  return (
                                    <tr key={lap.id} className="border-t border-app-border/20 hover:bg-app-surface-alt/30">
                                      <td className="px-2 py-1 text-center">
                                        <input
                                          type="checkbox"
                                          checked={selectedLaps.has(lap.id)}
                                          onChange={() => toggleLapSelection(lap.id)}
                                          className="accent-cyan-400 w-4 h-4"
                                        />
                                      </td>
                                      <td className="px-3 py-1 font-mono text-app-text-secondary">{lap.lapNumber}</td>
                                      <td className={`px-3 py-1 font-mono tabular-nums ${isBest ? "text-purple-400 font-bold" : "text-app-text"}`}>
                                        {formatLapTime(lap.lapTime)}
                                      </td>
                                      <td className="px-3 py-1">
                                        {lap.isValid ? (
                                          <span className="text-emerald-400">&#10003;</span>
                                        ) : (
                                          <span className="text-red-400" title={lap.invalidReason}>&#10007;</span>
                                        )}
                                      </td>
                                      <td className="px-3 py-1 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                          <Button
                                            variant="app-outline"
                                            size="app-sm"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              navigate({
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                to: `${gameRoute}/analyse` as any,
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                search: { track: session.trackOrdinal, car: session.carOrdinal, lap: lap.id } as any,
                                              });
                                            }}
                                          >
                                            Analyse
                                          </Button>
                                          <Button
                                            variant="app-danger"
                                            size="app-sm"
                                            onClick={(e) => { e.stopPropagation(); deleteLap.mutate(lap.id); }}
                                          >
                                            Delete
                                          </Button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-app-text-muted">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded bg-app-surface border border-app-border hover:bg-app-accent/10 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded bg-app-surface border border-app-border hover:bg-app-accent/10 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
