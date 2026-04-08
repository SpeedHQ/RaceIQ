import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import type { LapMeta, SessionMeta } from "@shared/types";
import { queryKeys, useSessions, useLaps, useDeleteLap } from "../hooks/queries";
import { useGameId, useGameRoute } from "../stores/game";
import { client } from "../lib/rpc";
import { formatLapTime } from "./LiveTelemetry";
import { Button } from "./ui/button";
import { AppInput } from "./ui/AppInput";

const PAGE_SIZE = 25;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fuzzyToken(token: string, field: string): boolean {
  return normalize(field).includes(normalize(token));
}

function NoteModal({ value, onSave, onClose }: { value?: string; onSave: (v: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const commit = () => { onSave(draft); onClose(); };
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[480px] max-w-[90vw] flex flex-col gap-3 p-4">
        <p className="text-xs font-medium text-app-text-secondary uppercase tracking-wider">Note</p>
        <textarea
          ref={ref}
          rows={5}
          className="w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs text-app-text outline-none resize-none focus:border-app-accent/60"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && e.metaKey) commit(); }}
          placeholder="Add a note…"
        />
        <div className="flex justify-end gap-2">
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>Cancel</Button>
          <Button variant="app-outline" size="app-sm" className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70" onClick={commit}>Save</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function NoteCell({ value, onSave }: { value?: string; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && <NoteModal value={value} onSave={onSave} onClose={() => setOpen(false)} />}
      <span
        className="relative cursor-pointer group block w-full"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <span className={`text-xs break-words whitespace-pre-wrap transition-opacity group-hover:opacity-30 ${value ? "text-app-text-secondary" : "text-app-text-dim italic"}`}>
          {value || "Add note…"}
        </span>
        <span className="absolute inset-0 flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-app-text-secondary text-[10px] font-medium">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Edit
        </span>
      </span>
    </>
  );
}

type LapSortKey = "lap" | "time" | "valid";

function SessionLapTable({ session, laps, lapSortKey, lapSortDir, toggleLapSort, selectedLaps, toggleLapSelection }: {
  session: SessionMeta;
  laps: LapMeta[];
  lapSortKey: LapSortKey;
  lapSortDir: SortDir;
  toggleLapSort: (k: LapSortKey) => void;
  selectedLaps: Set<number>;
  toggleLapSelection: (id: number) => void;
}) {
  const gameId = useGameId();
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: sectorTimes } = useQuery({
    queryKey: ["track-lap-sectors", session.trackOrdinal, gameId],
    queryFn: () => client.api.tracks[":ordinal"]["lap-sectors"].$get({ param: { ordinal: String(session.trackOrdinal) }, query: { gameId: gameId ?? undefined } }).then((r) => r.json() as unknown as Record<number, { s1: number; s2: number; s3: number }>),
    enabled: session.trackOrdinal != null,
  });

  const bestSectors = useMemo(() => {
    const best = { s1: Infinity, s2: Infinity, s3: Infinity };
    if (!sectorTimes) return best;
    for (const lap of laps) {
      const st = sectorTimes[lap.id];
      if (!st) continue;
      if (st.s1 > 0 && st.s1 < best.s1) best.s1 = st.s1;
      if (st.s2 > 0 && st.s2 < best.s2) best.s2 = st.s2;
      if (st.s3 > 0 && st.s3 < best.s3) best.s3 = st.s3;
    }
    return best;
  }, [sectorTimes, laps]);

  const sortedLaps = useMemo(() => [...laps].sort((a, b) => {
    if (lapSortKey === "lap") return lapSortDir === "asc" ? a.lapNumber - b.lapNumber : b.lapNumber - a.lapNumber;
    if (lapSortKey === "time") return lapSortDir === "asc" ? a.lapTime - b.lapTime : b.lapTime - a.lapTime;
    const av = a.isValid ? 1 : 0; const bv = b.isValid ? 1 : 0;
    return lapSortDir === "asc" ? bv - av : av - bv;
  }), [laps, lapSortKey, lapSortDir]);

  function sectorColor(time: number, best: number): string {
    if (best === Infinity || time <= 0) return "text-app-text-secondary";
    if (time <= best * 1.001) return "text-purple-400 font-bold";
    return "text-app-text-secondary";
  }

  return (
    <table className="w-full text-sm">
      <colgroup>
        <col className="w-10" />
        <col className="w-32" />
        <col className="w-16" />
        <col className="w-36" />
        <col className="w-8" />
        <col className="w-20" />
        <col className="w-20" />
        <col className="w-20" />
        <col className="w-[30%]" />
      </colgroup>
      <thead>
        <tr className="text-app-text-dim text-[10px] uppercase tracking-wider border-b border-app-border/30">
          <th className="w-10 px-2 py-1" />
          <th className="px-3 py-1 text-left" />
          {(["lap", "time", "valid"] as const).map((f) => (
            <th key={f} className="px-3 py-1 text-left cursor-pointer select-none hover:text-app-text" onClick={() => toggleLapSort(f)}>
              {f === "lap" ? "Lap" : f === "time" ? "Time" : "Valid"}
              {lapSortKey === f && <span className="ml-0.5">{lapSortDir === "asc" ? "↑" : "↓"}</span>}
            </th>
          ))}
          <th className="px-3 py-1 text-left text-red-400">S1</th>
          <th className="px-3 py-1 text-left text-blue-400">S2</th>
          <th className="px-3 py-1 text-left text-yellow-400">S3</th>
          <th className="px-3 py-1 text-left">Notes</th>
        </tr>
      </thead>
      <tbody>
        {sortedLaps.map((lap) => {
          const best = session.bestLapTime ?? 0;
          const isBest = best > 0 && Math.abs(lap.lapTime - best) < 0.001;
          return (
            <tr key={lap.id} className="border-t border-app-border/20 hover:bg-app-surface-alt/30">
              <td className="px-2 py-1 text-center">
                <input type="checkbox" checked={selectedLaps.has(lap.id)} onChange={() => toggleLapSelection(lap.id)} className="accent-cyan-400 w-4 h-4" />
              </td>
              <td />
              <td className="px-3 py-1 font-mono text-app-text-secondary">{lap.lapNumber}</td>
              <td className="px-3 py-1">
                <div className="flex items-center gap-2">
                  <span className={`font-mono tabular-nums ${isBest ? "text-purple-400 font-bold" : "text-app-text"}`}>{formatLapTime(lap.lapTime)}</span>
                  <Button variant="app-outline" size="app-sm" className="bg-cyan-900/50 !border-cyan-700 text-app-accent hover:bg-cyan-900/70"
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(e) => { e.stopPropagation(); navigate({ to: `${gameRoute}/analyse` as any, search: { track: session.trackOrdinal, car: session.carOrdinal, lap: lap.id } as any }); }}>
                    Analyse
                  </Button>
                </div>
              </td>
              <td className="px-3 py-1">
                {lap.isValid ? <span className="text-emerald-400">&#10003;</span> : <span className="text-red-400" title={lap.invalidReason}>&#10007;</span>}
              </td>
              {(["s1", "s2", "s3"] as const).map((s) => {
                const st = sectorTimes?.[lap.id];
                const val = st?.[s] ?? 0;
                return <td key={s} className={`px-3 py-1 font-mono text-xs ${sectorColor(val, bestSectors[s])}`}>{val > 0 ? formatLapTime(val) : "—"}</td>;
              })}
              <td className="px-3 py-1">
                <NoteCell value={lap.notes ?? undefined} onSave={(notes) => {
                  client.api.laps[":id"].notes.$patch({ param: { id: String(lap.id) }, json: { notes: notes || null } });
                  qc.invalidateQueries({ queryKey: queryKeys.laps });
                }} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

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
  const { data: sessions = [], isLoading } = useSessions();
  const { data: allLaps = [] } = useLaps();
  const qc = useQueryClient();
  useDeleteLap();

  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [lapSortKey, setLapSortKey] = useState<"lap" | "time" | "valid">("lap");
  const [lapSortDir, setLapSortDir] = useState<SortDir>("asc");
  const toggleLapSort = (key: "lap" | "time" | "valid") => {
    if (lapSortKey === key) setLapSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setLapSortKey(key); setLapSortDir("asc"); }
  };
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

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

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return sorted.filter((s) => {
      if (q) {
        const track = (trackNames[s.trackOrdinal] ?? "").toLowerCase();
        const car = (carNames[s.carOrdinal] ?? "").toLowerCase();
        const notes = (s.notes ?? "").toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        const anyFieldMatches = (token: string) =>
          fuzzyToken(token, track) || fuzzyToken(token, car) || fuzzyToken(token, notes);
        if (!tokens.every(anyFieldMatches)) return false;
      }
      return true;
    });
  }, [sorted, search, trackNames, carNames]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [sessions.length, search]);

  const toggleSessionSelection = useCallback((sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      const adding = !next.has(sessionId);
      if (adding) next.add(sessionId);
      else next.delete(sessionId);
      // Also select/deselect all laps in this session
      const laps = lapsBySession.get(sessionId) ?? [];
      setSelectedLaps((prevLaps) => {
        const nextLaps = new Set(prevLaps);
        for (const lap of laps) {
          if (adding) nextLaps.add(lap.id);
          else nextLaps.delete(lap.id);
        }
        return nextLaps;
      });
      return next;
    });
  }, [lapsBySession]);

  const toggleExpand = useCallback((sessionId: number) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleLapSelection = useCallback((lapId: number) => {
    setSelectedLaps((prev) => {
      const next = new Set(prev);
      if (next.has(lapId)) next.delete(lapId);
      else next.add(lapId);
      return next;
    });
  }, []);

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
  const colCount = isF1 ? 8 : 7;

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      <div className="flex items-center gap-3">
        <AppInput
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search track, car, notes…"
          className="w-64"
        />
        <h1 className="text-sm font-semibold text-app-text shrink-0">
          Sessions
          {!isLoading && (
            <span className="text-app-text-muted font-normal ml-2">
              {filtered.length === sessions.length ? `${sessions.length} total` : `${filtered.length} of ${sessions.length}`}
            </span>
          )}
        </h1>
        {(selectedSessions.size > 0 || selectedLaps.size > 0) && (
          <button
            onClick={deleteSelected}
            className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors"
          >
            Delete {selectedSessions.size > 0 ? `${selectedSessions.size} session${selectedSessions.size > 1 ? "s" : ""}` : ""}{selectedSessions.size > 0 && selectedLaps.size > 0 ? " + " : ""}{selectedLaps.size > 0 ? `${selectedLaps.size} lap${selectedLaps.size > 1 ? "s" : ""}` : ""}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-app-border">
        <table className="w-full text-sm">
          <colgroup>
            <col className="w-10" />  {/* checkbox */}
            <col className="w-40" />  {/* Date */}
            <col className="w-16" />  {/* Laps */}
            <col className="w-36" />  {/* Best Lap */}
            <col />                   {/* Track */}
            <col />                   {/* Car */}
            {isF1 && <col />}         {/* Type (F1) */}
            <col className="w-[30%]" />  {/* Notes */}
          </colgroup>
          <thead className="bg-app-surface sticky top-0 z-10">
            <tr className="border-b border-app-border">
              <th className="w-10 px-2">
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
              <SortHeader label="Laps" field="laps" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Best Lap" field="best" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Track" field="track" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              <SortHeader label="Car" field="car" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />
              {isF1 && <SortHeader label="Type" field="type" sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} />}
              <th className="px-3 py-2 text-left text-xs font-medium text-app-text-muted uppercase tracking-wider">Notes</th>
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
                const isExpanded = expandedSessions.has(session.id);
                const sessionLaps = lapsBySession.get(session.id) ?? [];
                const sortedLaps = [...sessionLaps].sort((a, b) => {
                  let cmp = 0;
                  if (lapSortKey === "lap") cmp = a.lapNumber - b.lapNumber;
                  else if (lapSortKey === "time") cmp = a.lapTime - b.lapTime;
                  else if (lapSortKey === "valid") cmp = (b.isValid ? 1 : 0) - (a.isValid ? 1 : 0);
                  return lapSortDir === "asc" ? cmp : -cmp;
                });
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
                      <td className="px-3 py-2 text-app-text-secondary tabular-nums">
                        {session.lapCount ?? 0}
                      </td>
                      <td className="px-3 py-2 text-app-text tabular-nums">
                        {(() => {
                          const t = session.bestLapTime || (sortedLaps.length > 0 ? Math.min(...sortedLaps.map((l) => l.lapTime)) : 0);
                          return t ? formatLapTime(t) : "—";
                        })()}
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
                      <td className="px-3 py-2">
                        <NoteCell
                          value={session.notes ?? undefined}
                          onSave={(notes) => {
                            client.api.sessions[":id"].notes.$patch({ param: { id: String(session.id) }, json: { notes: notes || null } });
                            qc.invalidateQueries({ queryKey: queryKeys.sessions });
                          }}
                        />
                      </td>
                    </tr>
                    {isExpanded && sessionLaps.length > 0 && (
                      <tr key={`${session.id}-laps`}>
                        <td colSpan={colCount} className="p-0">
                          <div className="bg-app-surface-alt/20 border-b border-app-border pl-8">
                            <SessionLapTable
                              session={session}
                              laps={sessionLaps}
                              lapSortKey={lapSortKey}
                              lapSortDir={lapSortDir}
                              toggleLapSort={toggleLapSort}
                              selectedLaps={selectedLaps}
                              toggleLapSelection={toggleLapSelection}
                            />
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
