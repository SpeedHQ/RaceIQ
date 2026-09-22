import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionCleanupRequest, SessionCleanupResult } from "@shared/racing/sessions/cleanup";
import { SessionCleanupDialog } from "@/components/SessionCleanupDialog";
import { SessionRecapModal } from "@/components/SessionRecapModal";
import { Button } from "@/components/ui/button";
import { useDeleteLap, useLaps } from "@/hooks/laps";
import { queryKeys } from "@/hooks/query-keys";
import { useSessions } from "@/hooks/session-queries";
import { useResolveNames } from "@/hooks/catalog-queries";
import { client } from "@/lib/rpc";
import { exportLapsZip } from "@/lib/lap-export";
import { storedLapsSectorCount } from "@/lib/lap-sectors";
import { routePrefixForGameId } from "@/lib/game-routes";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import { filterSessions, groupLapsBySession, PAGE_SIZE, paginateSessions, selectionIncludesMotec, sortSessions } from "./helpers";
import { SessionDesktopTable } from "./SessionDesktopTable";
import { SessionMobileList } from "./SessionMobileList";
import { SessionImportModal } from "./SessionImportModal";
import { SessionToolbar } from "./SessionToolbar";
import type { SessionMeta } from "@shared/racing/sessions/types";
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
  const trackOrdinals = useMemo(() => [...new Set(sessions.map((session) => session.trackOrdinal).filter((ordinal): ordinal is number => !!ordinal))].sort((a, b) => a - b), [sessions]);
  const carOrdinals = useMemo(() => [...new Set(sessions.map((session) => session.carOrdinal).filter((ordinal): ordinal is number => !!ordinal))].sort((a, b) => a - b), [sessions]);
  const { data: resolvedNames } = useResolveNames(trackOrdinals, carOrdinals);
  const trackNames = resolvedNames?.trackNames ?? {};
  const lapsBySession = useMemo(() => groupLapsBySession(allLaps), [allLaps]);
  const carNames = resolvedNames?.carNames ?? {};
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cleanupRequest, setCleanupRequest] = useState<SessionCleanupRequest | null>(null);
  const [recapSessionId, setRecapSessionId] = useState<number | null>(null);
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

  const runExport = useCallback(
    async (selection: { lapIds?: number[]; sessionIds?: number[] }) => {
      if (selectionIncludesMotec(selection, sessions, allLaps) && !window.confirm(m.sessions_export_motec_whole_session_confirm())) {
        return;
      }
      setExporting(true);
      try {
        await exportLapsZip(selection);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      } finally {
        setExporting(false);
      }
    },
    [allLaps, sessions],
  );
  const analyseSession = useCallback(
    (session: SessionMeta) => {
      if (!gameId) return;
      const routePrefix = routePrefixForGameId(gameId);
      if (!routePrefix) return;
      void navigate({ to: `/${routePrefix}/sessions/${session.id}/analyse` as never });
    },
    [gameId, navigate],
  );

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
  const filtered = useMemo(() => filterSessions(sorted, search, tab, { trackNames, carNames }, favoriteOnly), [sorted, search, tab, trackNames, carNames, favoriteOnly]);
  const { items: pageItems, totalPages } = useMemo(() => paginateSessions(filtered, page), [filtered, page]);
  useEffect(() => {
    setPage(0);
  }, [sessions.length, search, favoriteOnly]);

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
  const completedCleanup = useCallback(
    (result: SessionCleanupResult) => {
      setSelectedSessions((previous) => {
        const next = new Set(previous);
        for (const id of result.cleanedSessionIds) next.delete(id);
        return next;
      });
      setSelectedLaps((previous) => {
        const next = new Set(previous);
        for (const lap of allLaps) if (result.cleanedSessionIds.includes(lap.sessionId)) next.delete(lap.id);
        return next;
      });
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus }),
      ]);
    },
    [allLaps, queryClient],
  );
  const saveSessionNotes = useCallback(
    (sessionId: number, notes: string) => {
      void client.api.sessions[":id"].notes.$patch({ param: { id: String(sessionId) }, json: { notes: notes || null } });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    [queryClient],
  );
  const isF1 = gameId === "f1-2025";
  const colCount = isF1 ? 9 : 8;
  const emptyMessage = favoriteOnly ? m.sessions_none_favorites() : tab === "others" ? m.sessions_none_others() : m.sessions_none();

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {recapSessionId != null && <SessionRecapModal sessionId={recapSessionId} gameId={gameId} onClose={() => setRecapSessionId(null)} />}
      {importOpen && (
        <SessionImportModal
          gameId={gameId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
            void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
          }}
        />
      )}
      <SessionCleanupDialog request={cleanupRequest} onClose={() => setCleanupRequest(null)} onCompleted={completedCleanup} />
      <SessionToolbar
        sessions={sessions}
        allLaps={allLaps}
        filteredCount={filtered.length}
        isLoading={isLoading}
        sessionsError={sessionsError}
        tab={tab}
        setTab={setTab}
        favoriteOnly={favoriteOnly}
        setFavoriteOnly={(value) => {
          setFavoriteOnly(value);
          setPage(0);
        }}
        search={search}
        setSearch={setSearch}
        setPage={setPage}
        selectedSessions={selectedSessions}
        selectedLaps={selectedLaps}
        exporting={exporting}
        runExport={runExport}
        setImportOpen={setImportOpen}
        openCleanup={() => setCleanupRequest({ mode: "selected", sessionIds: [...selectedSessions] })}
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
        analyseSession={analyseSession}
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
        analyseSession={analyseSession}
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
