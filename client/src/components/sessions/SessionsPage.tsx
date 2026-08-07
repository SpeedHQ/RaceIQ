import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MotecImportModal } from "@/components/analyse/MotecImportModal";
import { SessionRecapModal } from "@/components/SessionRecapModal";
import { Button } from "@/components/ui/button";
import { useDeleteLap, useLaps } from "@/hooks/laps";
import { queryKeys } from "@/hooks/query-keys";
import { useSessions } from "@/hooks/session-queries";
import { exportLapsZip } from "@/lib/lap-export";
import { storedLapsSectorCount } from "@/lib/lap-sectors";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import { filterSessions, groupLapsBySession, PAGE_SIZE, paginateSessions, sortSessions } from "./helpers";
import { SessionDesktopTable } from "./SessionDesktopTable";
import { SessionMobileList } from "./SessionMobileList";
import { SessionToolbar } from "./SessionToolbar";
import type { LapSortKey, SessionSelectionEvent, SessionsTab, SortDir, SortKey } from "./types";

export function SessionsPage() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const { data: sessions = [], isLoading, isError: sessionsError } = useSessions();
  const { data: allLaps = [] } = useLaps();
  const queryClient = useQueryClient();
  useDeleteLap();
  const sectorCount = Math.max(3, storedLapsSectorCount(allLaps));
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [lapSortKey, setLapSortKey] = useState<LapSortKey>("lap");
  const [lapSortDir, setLapSortDir] = useState<SortDir>("asc");
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
  const [importOpen, setImportOpen] = useState(false);
  const routeSearch = useSearch({ strict: false }) as { tab?: string };
  const tab: SessionsTab = routeSearch.tab === "others" ? "others" : "mine";
  const setTab = useCallback(
    (nextTab: SessionsTab) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to: ".", search: (previous: any) => ({ ...previous, tab: nextTab === "mine" ? undefined : nextTab }) } as any);
      setPage(0);
    },
    [navigate],
  );

  const runExport = useCallback(async (selection: { lapIds?: number[]; sessionIds?: number[] }) => {
    setExporting(true);
    try {
      await exportLapsZip(selection);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }, []);

  const lapsBySession = useMemo(() => groupLapsBySession(allLaps), [allLaps]);
  useEffect(() => {
    const trackOrdinals = new Set<number>();
    const carOrdinals = new Set<number>();
    for (const session of sessions) {
      if (session.trackOrdinal) trackOrdinals.add(session.trackOrdinal);
      if (session.carOrdinal) carOrdinals.add(session.carOrdinal);
    }
    for (const ordinal of trackOrdinals) {
      if (!trackNames[ordinal]) {
        client.api["track-name"][":ordinal"]
          .$get({ param: { ordinal: String(ordinal) }, query: { gameId: gameId! } })
          .then((response) => (response.ok ? response.text() : ""))
          .then((name) => {
            if (name) setTrackNames((previous) => ({ ...previous, [ordinal]: name }));
          })
          .catch(() => {});
      }
    }
    for (const ordinal of carOrdinals) {
      if (!carNames[ordinal]) {
        client.api["car-name"][":ordinal"]
          .$get({ param: { ordinal: String(ordinal) }, query: { gameId: gameId! } })
          .then((response) => (response.ok ? response.text() : ""))
          .then((name) => {
            if (name) setCarNames((previous) => ({ ...previous, [ordinal]: name }));
          })
          .catch(() => {});
      }
    }
  }, [sessions, gameId, trackNames, carNames]);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
      else {
        setSortKey(key);
        setSortDir(key === "best" ? "asc" : "desc");
      }
    },
    [sortKey],
  );
  const toggleLapSort = useCallback(
    (key: LapSortKey) => {
      if (lapSortKey === key) setLapSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
      else {
        setLapSortKey(key);
        setLapSortDir("asc");
      }
    },
    [lapSortKey],
  );

  const sorted = useMemo(() => sortSessions(sessions, sortKey, sortDir, { trackNames, carNames }), [sessions, sortKey, sortDir, trackNames, carNames]);
  const filtered = useMemo(() => filterSessions(sorted, search, tab, { trackNames, carNames }), [sorted, search, tab, trackNames, carNames]);
  const { items: pageItems, totalPages } = useMemo(() => paginateSessions(filtered, page), [filtered, page]);
  useEffect(() => {
    setPage(0);
  }, [sessions.length, search]);

  const toggleSessionSelection = useCallback(
    (sessionId: number, event: SessionSelectionEvent) => {
      event.stopPropagation();
      setSelectedSessions((previous) => {
        const next = new Set(previous);
        const adding = !next.has(sessionId);
        if (adding) next.add(sessionId);
        else next.delete(sessionId);
        const sessionLaps = lapsBySession.get(sessionId) ?? [];
        setSelectedLaps((previousLaps) => {
          const nextLaps = new Set(previousLaps);
          for (const lap of sessionLaps) {
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
  const toggleExpand = useCallback(
    (sessionId: number) =>
      setExpandedSessions((previous) => {
        const next = new Set(previous);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      }),
    [],
  );
  const toggleLapSelection = useCallback(
    (lapId: number) =>
      setSelectedLaps((previous) => {
        const next = new Set(previous);
        if (next.has(lapId)) next.delete(lapId);
        else next.add(lapId);
        return next;
      }),
    [],
  );
  const deleteSelected = useCallback(async () => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      if (selectedSessions.size > 0) {
        const response = await client.api.sessions["bulk-delete"].$post({ json: { ids: [...selectedSessions] } });
        if (!response.ok) throw new Error("Failed to delete selected sessions");
      }
      if (selectedLaps.size > 0) {
        const response = await client.api.laps["bulk-delete"].$post({ json: { ids: [...selectedLaps] } });
        if (!response.ok) throw new Error("Failed to delete selected laps");
      }
      setSelectedLaps(new Set());
      setSelectedSessions(new Set());
      setConfirmDelete(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.sessions }), queryClient.invalidateQueries({ queryKey: queryKeys.laps })]);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  }, [selectedLaps, selectedSessions, queryClient]);
  const saveSessionNotes = useCallback(
    (sessionId: number, notes: string) => {
      void client.api.sessions[":id"].notes.$patch({ param: { id: String(sessionId) }, json: { notes: notes || null } });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    [queryClient],
  );
  const isF1 = gameId === "f1-2025";
  const colCount = isF1 ? 9 : 8;
  const emptyMessage = tab === "others" ? m.sessions_none_others() : m.sessions_none();

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {recapSessionId != null && <SessionRecapModal sessionId={recapSessionId} gameId={gameId} onClose={() => setRecapSessionId(null)} />}
      {importOpen && (
        <MotecImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
            void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
          }}
        />
      )}
      <SessionToolbar
        sessions={sessions}
        allLaps={allLaps}
        filteredCount={filtered.length}
        isLoading={isLoading}
        sessionsError={sessionsError}
        tab={tab}
        setTab={setTab}
        search={search}
        setSearch={setSearch}
        setPage={setPage}
        selectedSessions={selectedSessions}
        selectedLaps={selectedLaps}
        setImportOpen={setImportOpen}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        deleteSelected={deleteSelected}
        isDeleting={isDeleting}
        deleteError={deleteError}
      />
      <SessionMobileList
        sessions={pageItems}
        lapsBySession={lapsBySession}
        trackNames={trackNames}
        carNames={carNames}
        isLoading={isLoading}
        sessionsError={sessionsError}
        isF1={isF1}
        gameId={gameId}
        emptyMessage={emptyMessage}
        expandedSessions={expandedSessions}
        toggleExpand={toggleExpand}
        selectedSessions={selectedSessions}
        toggleSessionSelection={toggleSessionSelection}
        selectedLaps={selectedLaps}
        toggleLapSelection={toggleLapSelection}
        sectorCount={sectorCount}
        lapSortKey={lapSortKey}
        lapSortDir={lapSortDir}
        toggleLapSort={toggleLapSort}
        saveSessionNotes={saveSessionNotes}
        exporting={exporting}
        runExport={runExport}
        setRecapSessionId={setRecapSessionId}
      />
      <SessionDesktopTable
        lapsBySession={lapsBySession}
        trackNames={trackNames}
        carNames={carNames}
        isLoading={isLoading}
        sessionsError={sessionsError}
        isF1={isF1}
        gameId={gameId}
        emptyMessage={emptyMessage}
        colCount={colCount}
        pageItems={pageItems}
        sortKey={sortKey}
        sortDir={sortDir}
        toggleSort={toggleSort}
        expandedSessions={expandedSessions}
        toggleExpand={toggleExpand}
        selectedSessions={selectedSessions}
        setSelectedSessions={setSelectedSessions}
        toggleSessionSelection={toggleSessionSelection}
        selectedLaps={selectedLaps}
        toggleLapSelection={toggleLapSelection}
        sectorCount={sectorCount}
        lapSortKey={lapSortKey}
        lapSortDir={lapSortDir}
        toggleLapSort={toggleLapSort}
        saveSessionNotes={saveSessionNotes}
        exporting={exporting}
        runExport={runExport}
        setRecapSessionId={setRecapSessionId}
      />
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-app-text/90">
          <span>
            {m.sessions_showing_prefix()} {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} {m.sessions_showing_of()} {filtered.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="app-outline"
              size="app-sm"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="!py-1 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {m.sessions_prev()}
            </Button>
            <Button
              variant="app-outline"
              size="app-sm"
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
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
