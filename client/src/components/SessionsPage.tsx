import { MOTEC_SESSION_SOURCE, motecImportSupported } from "@shared/integrations/motec";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import type { LapMeta, SessionMeta } from "../../../shared/racing/sessions/types";
import { queryKeys, useDeleteLap, useLaps, useSessions } from "../hooks/queries";
import { exportLapsZip } from "../lib/lap-export";
import { storedLapsSectorCount } from "../lib/lap-sectors";
import { client } from "../lib/rpc";
import { useGameId, useGameRoute } from "../stores/game";
import { MotecImportModal } from "./analyse/MotecImportModal";
import { formatLapTime } from "./LiveTelemetry";
import { RaceResultLedger } from "./race-results/RaceResultLedger";
import { SessionRecapModal } from "./SessionRecapModal";
import { AppInput } from "./ui/AppInput";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";
import { Button } from "./ui/button";
import { NoteModal } from "./ui/NoteModal";

export type SessionsTab = "recorded" | "imported";

const PAGE_SIZE = 25;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fuzzyToken(token: string, field: string): boolean {
  return normalize(field).includes(normalize(token));
}

function NoteCell({ value, onSave }: { value?: string; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && <NoteModal value={value} onSave={onSave} onClose={() => setOpen(false)} />}
      <Button
        type="button"
        className="relative cursor-pointer group block w-full text-left"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <span className={`text-xs break-words whitespace-pre-wrap transition-opacity group-hover:opacity-30 ${value ? "text-app-text/90" : "text-app-text/90 italic"}`}>
          {value || m.sessions_add_note()}
        </span>
        <span className="absolute inset-0 flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-app-text/90 text-app-caption font-medium">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          {m.common_edit()}
        </span>
      </Button>
    </>
  );
}

function SessionResultMeta({ session }: { session: SessionMeta }) {
  const position = session.finishingPosition;
  return position != null ? <span className="text-xs font-medium">P{position}</span> : <span className="text-app-text/60">—</span>;
}

type LapSortKey = "lap" | "time";

function SessionLapTable({
  session,
  laps,
  sectorCount,
  lapSortKey,
  lapSortDir,
  toggleLapSort,
  selectedLaps,
  toggleLapSelection,
}: {
  session: SessionMeta;
  laps: LapMeta[];
  sectorCount: number;
  lapSortKey: LapSortKey;
  lapSortDir: SortDir;
  toggleLapSort: (k: LapSortKey) => void;
  selectedLaps: Set<number>;
  toggleLapSelection: (id: number) => void;
}) {
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; lapId: number } | null>(null);

  const sectorLabels = Array.from({ length: sectorCount }, (_, index) => `S${index + 1}`);

  const bestSectors = useMemo(() => {
    return Array.from({ length: sectorCount }, (_, index) => {
      const times = laps.map((lap) => lap.sectorTimes?.[index] ?? 0).filter((time) => time > 0);
      return times.length > 0 ? Math.min(...times) : Infinity;
    });
  }, [laps, sectorCount]);

  const sortedLaps = useMemo(
    () =>
      [...laps].sort((a, b) => {
        if (lapSortKey === "lap") return lapSortDir === "asc" ? a.lapNumber - b.lapNumber : b.lapNumber - a.lapNumber;
        return lapSortDir === "asc" ? a.lapTime - b.lapTime : b.lapTime - a.lapTime;
      }),
    [laps, lapSortKey, lapSortDir],
  );

  function sectorColor(time: number, best: number): string {
    if (best === Infinity || time <= 0) return "text-app-text/90";
    if (time <= best * 1.001) return "text-(--lap-pace-best) font-bold";
    return "text-app-text/90";
  }

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
            const best = session.bestLapTime ?? 0;
            const isBest = best > 0 && Math.abs(lap.lapTime - best) < 0.001;
            return (
              <TRow
                key={lap.id}
                onContextMenu={(e: React.MouseEvent) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, lapId: lap.id });
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
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: `${gameRoute}/analyse` as any, search: { track: session.trackOrdinal, car: session.carOrdinal, lap: lap.id } as any });
                      }}
                    >
                      {m.label_analyse()}
                    </Button>
                  </div>
                </TD>
                {sectorLabels.map((label, index) => {
                  const val = lap.sectorTimes?.[index] ?? 0;
                  return (
                    <TD key={label} numeric>
                      <span className={sectorColor(val, bestSectors[index])}>{val > 0 ? formatLapTime(val) : "—"}</span>
                    </TD>
                  );
                })}
                <TD>
                  <NoteCell
                    value={lap.notes ?? undefined}
                    onSave={(notes) => {
                      client.api.laps[":id"].notes.$patch({ param: { id: String(lap.id) }, json: { notes: notes || null } });
                      qc.invalidateQueries({ queryKey: queryKeys.laps });
                    }}
                  />
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>

      {/* Dev context menu */}
      {contextMenu && (
        <>
          <Button
            type="button"
            aria-label={m.common_close()}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div className="fixed z-50 bg-app-surface border border-app-border rounded shadow-lg py-1 text-sm" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <Button
              variant="app-ghost"
              size="app-sm"
              className="w-full !justify-start !rounded-none !px-3 !py-1.5 text-left text-app-text hover:bg-app-surface-hover"
              onClick={async () => {
                const res = await fetch(`/api/laps/${contextMenu.lapId}/recheck`, { method: "POST" });
                const data = await res.json();
                console.log("[Recheck]", data);
                qc.invalidateQueries({ queryKey: queryKeys.laps });
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
                } catch (e) {
                  window.alert(e instanceof Error ? e.message : String(e));
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

type SortKey = "date" | "track" | "car" | "laps" | "best" | "type" | "result";
type SortDir = "asc" | "desc";

function formatSessionType(type?: string): string {
  if (!type || type === "unknown") return "";
  return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SessionsPage() {
  const gameId = useGameId();
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const { data: sessions = [], isLoading, isError: sessionsError } = useSessions();
  const { data: allLaps = [] } = useLaps();
  const sectorCount = Math.max(3, storedLapsSectorCount(allLaps));
  const qc = useQueryClient();
  useDeleteLap();

  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [lapSortKey, setLapSortKey] = useState<LapSortKey>("lap");
  const [lapSortDir, setLapSortDir] = useState<SortDir>("asc");
  const toggleLapSort = (key: LapSortKey) => {
    if (lapSortKey === key) setLapSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setLapSortKey(key);
      setLapSortDir("asc");
    }
  };
  const [trackNames, setTrackNames] = useState<Record<number, string>>({});
  const [carNames, setCarNames] = useState<Record<number, string>>({});
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [recapSessionId, setRecapSessionId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * Recorded and imported sessions are listed apart rather than mixed with a
   * badge: an imported MoTeC lap has a dead-reckoned line and no absolute
   * position, so it is not a like-for-like row next to a recorded session.
   */
  const routeSearch = useSearch({ strict: false }) as { tab?: string };
  /**
   * A stale/hand-typed `?tab=imported` on a game without a verified MoTeC
   * mapping falls back to the recorded list — that game has no imports and no
   * tab strip to switch back with.
   */
  const tab: SessionsTab = routeSearch.tab === "imported" && motecImportSupported(gameId) ? "imported" : "recorded";
  /** The tab lives in the URL so a MoTeC import is linkable and survives reload. */
  const setTab = useCallback(
    (next: SessionsTab) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to: ".", search: (prev: any) => ({ ...prev, tab: next === "recorded" ? undefined : next }) } as any);
    },
    [navigate],
  );
  const [importOpen, setImportOpen] = useState(false);

  /** Download laps/sessions as a .zip; surfaces server errors inline. */
  const runExport = useCallback(async (sel: { lapIds?: number[]; sessionIds?: number[] }) => {
    setExporting(true);
    try {
      await exportLapsZip(sel);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, []);

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
        client.api["track-name"][":ordinal"]
          .$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
          .then((r) => (r.ok ? r.text() : ""))
          .then((name) => {
            if (name) setTrackNames((prev) => ({ ...prev, [ord]: name }));
          })
          .catch(() => {});
      }
    }
    for (const ord of carOrds) {
      if (!carNames[ord]) {
        client.api["car-name"][":ordinal"]
          .$get({ param: { ordinal: String(ord) }, query: { gameId: gameId! } })
          .then((r) => (r.ok ? r.text() : ""))
          .then((name) => {
            if (name) setCarNames((prev) => ({ ...prev, [ord]: name }));
          })
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
        case "result":
          valA = a.resultClassification ?? "";
          valB = b.resultClassification ?? "";
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
      const imported = s.source === MOTEC_SESSION_SOURCE;
      if (imported !== (tab === "imported")) return false;
      if (q) {
        const track = (trackNames[s.trackOrdinal] ?? "").toLowerCase();
        const car = (carNames[s.carOrdinal] ?? "").toLowerCase();
        const notes = (s.notes ?? "").toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        const anyFieldMatches = (token: string) => fuzzyToken(token, track) || fuzzyToken(token, car) || fuzzyToken(token, notes);
        if (!tokens.every(anyFieldMatches)) return false;
      }
      return true;
    });
  }, [sorted, search, trackNames, carNames, tab]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [sessions.length, search]);

  const toggleSessionSelection = useCallback(
    (sessionId: number, e: React.MouseEvent) => {
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
    },
    [lapsBySession],
  );

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
    setIsDeleting(true);
    setDeleteError(null);
    try {
      if (selectedSessions.size > 0) {
        const response = await client.api.sessions["bulk-delete"].$post({
          json: { ids: [...selectedSessions] },
        });
        if (!response.ok) throw new Error("Failed to delete selected sessions");
      }
      if (selectedLaps.size > 0) {
        const response = await client.api.laps["bulk-delete"].$post({
          json: { ids: [...selectedLaps] },
        });
        if (!response.ok) throw new Error("Failed to delete selected laps");
      }
      setSelectedLaps(new Set());
      setSelectedSessions(new Set());
      setConfirmDelete(false);
      await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.sessions }), qc.invalidateQueries({ queryKey: queryKeys.laps })]);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  }, [selectedLaps, selectedSessions, qc]);

  /** Only games with a verified MoTeC channel mapping get the import UI. */
  const motecEnabled = motecImportSupported(gameId);
  const isF1 = gameId === "f1-2025";
  const colCount = isF1 ? 9 : 8;

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {recapSessionId != null && <SessionRecapModal sessionId={recapSessionId} gameId={gameId} onClose={() => setRecapSessionId(null)} />}
      {importOpen && (
        <MotecImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            qc.invalidateQueries({ queryKey: ["sessions"] });
            qc.invalidateQueries({ queryKey: ["laps"] });
          }}
        />
      )}
      <div className="flex items-center flex-wrap gap-3">
        {motecEnabled && (
          <div className="flex items-center rounded border border-app-border overflow-hidden shrink-0">
            {(["recorded", "imported"] as const satisfies readonly SessionsTab[]).map((t) => (
              <Button
                key={t}
                variant="app-ghost"
                size="app-md"
                onClick={() => {
                  setTab(t);
                  setPage(0);
                  setSelectedSessions(new Set());
                  setSelectedLaps(new Set());
                }}
                className={`!rounded-none text-sm font-semibold transition-colors ${tab === t ? "bg-app-accent text-app-on-filled" : "text-app-text/90 hover:text-app-text"}`}
              >
                {t === "recorded" ? m.sessions_tab_recorded() : m.sessions_tab_imported()}
              </Button>
            ))}
          </div>
        )}
        <AppInput
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={m.sessions_search_placeholder()}
          className="min-w-[200px] flex-1 @3xl/workspace:w-64 @3xl/workspace:flex-none"
        />
        <h1 className="text-sm font-semibold text-app-text/90 shrink-0">
          {m.label_sessions()}
          {!isLoading && !sessionsError && (
            <span className="text-app-subtext text-app-text/90 font-normal ml-2">
              {filtered.length === sessions.length ? `${sessions.length} ${m.sessions_total()}` : `${filtered.length} ${m.sessions_filtered_count()} ${sessions.length}`}
            </span>
          )}
        </h1>
        <div className="flex items-center flex-wrap gap-2">
          {tab === "imported" && (
            <Button variant="app-outline" size="app-sm" onClick={() => setImportOpen(true)}>
              {m.sessions_import_motec()}
            </Button>
          )}
          {selectedLaps.size === 2 &&
            (() => {
              // Only show Compare when the two selected laps are from sessions
              // on the same track — the compare route expects a single track.
              const ids = [...selectedLaps];
              const lapA = allLaps.find((l) => l.id === ids[0]);
              const lapB = allLaps.find((l) => l.id === ids[1]);
              if (!lapA || !lapB) return null;
              const sessA = sessions.find((s) => s.id === lapA.sessionId);
              const sessB = sessions.find((s) => s.id === lapB.sessionId);
              if (!sessA || !sessB) return null;
              if (sessA.trackOrdinal !== sessB.trackOrdinal) return null;
              return (
                <Button
                  variant="app-primary"
                  size="app-md"
                  onClick={() => {
                    // Compare is shared across all game routes.
                    // TanStack Router types don't know about the dynamic gameRoute
                    // template; use the same escape hatch as the per-lap navigate above.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const args: any = {
                      to: `${gameRoute}/compare`,
                      search: {
                        track: sessA.trackOrdinal,
                        carA: sessA.carOrdinal,
                        carB: sessB.carOrdinal,
                        lapA: lapA.id,
                        lapB: lapB.id,
                      },
                    };
                    navigate(args);
                  }}
                >
                  {m.sessions_compare_two()}
                </Button>
              );
            })()}
          {(selectedSessions.size > 0 || selectedLaps.size > 0) &&
            (!confirmDelete ? (
              <Button variant="app-danger" size="app-md" onClick={() => setConfirmDelete(true)}>
                {m.common_delete()} {selectedSessions.size > 0 ? `${selectedSessions.size} ${m.sessions_count_sessions()}` : ""}
                {selectedSessions.size > 0 && selectedLaps.size > 0 ? " + " : ""}
                {selectedLaps.size > 0 ? `${selectedLaps.size} ${m.sessions_count_laps()}` : ""}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-app-caption font-medium text-status-danger">{m.trackdetail_confirm()}</span>
                <Button variant="app-danger" size="app-sm" onClick={deleteSelected} disabled={isDeleting}>
                  {isDeleting ? m.common_loading() : m.trackdetail_yes()}
                </Button>
                <Button variant="app-outline" size="app-sm" onClick={() => setConfirmDelete(false)} disabled={isDeleting}>
                  {m.common_cancel()}
                </Button>
              </div>
            ))}
        </div>
        {deleteError && (
          <p role="alert" className="text-app-caption text-status-danger">
            {deleteError}
          </p>
        )}
        {sessionsError && (
          <p role="alert" className="text-app-caption text-status-danger">
            {m.common_error()}
          </p>
        )}
      </div>

      {/* Mobile card list */}
      <div className="flex flex-1 flex-col gap-2 overflow-auto @3xl/workspace:hidden">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-app-text/90">{m.common_loading()}</div>
        ) : sessionsError ? null : pageItems.length === 0 ? (
          <div className="px-3 py-8 text-center text-app-text/90">{tab === "imported" ? m.sessions_none_imported() : m.sessions_none()}</div>
        ) : (
          pageItems.map((session) => {
            const isExpanded = expandedSessions.has(session.id);
            const sessionLaps = lapsBySession.get(session.id) ?? [];
            const bestTime = session.bestLapTime || (sessionLaps.length > 0 ? Math.min(...sessionLaps.map((l) => l.lapTime)) : 0);
            return (
              <div key={session.id} className={`rounded-lg border border-app-border bg-app-surface ${isExpanded ? "bg-app-surface-alt/40" : ""}`}>
                {/* Whole card toggles the lap list on tap. Nested controls
                    (checkbox, Recap/Export) stop propagation themselves. */}
                {/* biome-ignore lint/a11y/useSemanticElements: cannot be a real <button> — it wraps a checkbox and two buttons, which may not nest inside one */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  className="flex items-start gap-3 p-3 cursor-pointer"
                  onClick={() => toggleExpand(session.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(session.id);
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedSessions.has(session.id)}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onChange={(e) => toggleSessionSelection(session.id, e as any)}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-app-accent w-5 h-5 mt-0.5 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-sm font-semibold text-app-text truncate">{trackNames[session.trackOrdinal] ?? `Track ${session.trackOrdinal}`}</div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-app-compact text-app-text/90">
                          {new Date(session.createdAt).toLocaleDateString()} {new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                        <Button
                          variant="app-outline"
                          size="app-sm"
                          onClick={(e) => {
                            e.stopPropagation();
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
                          onClick={(e) => {
                            e.stopPropagation();
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
                    {/* Contains the note button and its modal; keeps their
                        clicks from reaching the card's expand toggle. */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: event containment only, no behaviour of its own */}
                    <div role="presentation" className="mt-2" onClick={(e) => e.stopPropagation()}>
                      <NoteCell
                        value={session.notes ?? undefined}
                        onSave={(notes) => {
                          client.api.sessions[":id"].notes.$patch({ param: { id: String(session.id) }, json: { notes: notes || null } });
                          qc.invalidateQueries({ queryKey: queryKeys.sessions });
                        }}
                      />
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

      <div className="hidden flex-1 overflow-auto @3xl/workspace:block">
        <Table fit>
          <THead>
            <TH>
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
                ...(isF1 ? ([["type", m.label_type()]] as const) : []),
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
                  <div className="py-6">{tab === "imported" ? m.sessions_none_imported() : m.sessions_none()}</div>
                </TD>
              </TRow>
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
                  <Fragment key={session.id}>
                    <TRow onClick={() => toggleExpand(session.id)} selected={isExpanded}>
                      <TD align="center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedSessions.has(session.id)}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          onChange={(e) => toggleSessionSelection(session.id, e as any)}
                          className="accent-app-accent w-4 h-4"
                        />
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
                            onClick={(e) => {
                              e.stopPropagation();
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
                            onClick={(e) => {
                              e.stopPropagation();
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
                        {(() => {
                          const t = session.bestLapTime || (sortedLaps.length > 0 ? Math.min(...sortedLaps.map((l) => l.lapTime)) : 0);
                          return t ? formatLapTime(t) : "—";
                        })()}
                      </TD>
                      <TD tone="primary">{trackNames[session.trackOrdinal] ?? `Track ${session.trackOrdinal}`}</TD>
                      <TD tone="primary">{carNames[session.carOrdinal] ?? (session.carOrdinal === 0 ? "—" : `Car ${session.carOrdinal}`)}</TD>
                      <TD tone="primary">
                        <SessionResultMeta session={session} />
                      </TD>
                      {isF1 && <TD tone="primary">{formatSessionType(session.sessionType)}</TD>}
                      <TD>
                        <NoteCell
                          value={session.notes ?? undefined}
                          onSave={(notes) => {
                            client.api.sessions[":id"].notes.$patch({ param: { id: String(session.id) }, json: { notes: notes || null } });
                            qc.invalidateQueries({ queryKey: queryKeys.sessions });
                          }}
                        />
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-app-text/90">
          <span>
            {m.sessions_showing_prefix()} {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} {m.sessions_showing_of()} {filtered.length}
          </span>
          <div className="flex gap-1">
            <Button variant="app-outline" size="app-sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="!py-1 disabled:opacity-30 disabled:cursor-not-allowed">
              {m.sessions_prev()}
            </Button>
            <Button
              variant="app-outline"
              size="app-sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="!py-1 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {m.common_next()}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
