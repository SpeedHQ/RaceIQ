import { motecImportSupported } from "@shared/integrations/motec";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { useNavigate } from "@tanstack/react-router";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { useGameId, useGameRoute } from "@/stores/game";
import type { SessionsTab } from "./types";

export type SessionToolbarProps = {
  sessions: SessionMeta[];
  allLaps: LapMeta[];
  filteredCount: number;
  isLoading: boolean;
  sessionsError: boolean;
  tab: SessionsTab;
  setTab: (tab: SessionsTab) => void;
  search: string;
  setSearch: (value: string) => void;
  setPage: (page: number) => void;
  selectedSessions: Set<number>;
  selectedLaps: Set<number>;
  setImportOpen: (open: boolean) => void;
  confirmDelete: boolean;
  setConfirmDelete: (confirm: boolean) => void;
  deleteSelected: () => void;
  isDeleting: boolean;
  deleteError: string | null;
};

export function SessionToolbar({
  sessions,
  allLaps,
  filteredCount,
  isLoading,
  sessionsError,
  tab,
  setTab,
  search,
  setSearch,
  setPage,
  selectedSessions,
  selectedLaps,
  setImportOpen,
  confirmDelete,
  setConfirmDelete,
  deleteSelected,
  isDeleting,
  deleteError,
}: SessionToolbarProps) {
  const gameId = useGameId();
  const gameRoute = useGameRoute();
  const navigate = useNavigate();
  const motecEnabled = motecImportSupported(gameId);

  return (
    <div className="flex items-center flex-wrap gap-3">
      {motecEnabled && (
        <div className="flex items-center rounded border border-app-border overflow-hidden shrink-0">
          {(["recorded", "imported"] as const satisfies readonly SessionsTab[]).map((nextTab) => (
            <Button
              key={nextTab}
              variant="app-ghost"
              size="app-md"
              onClick={() => {
                setTab(nextTab);
                setPage(0);
              }}
              className={`!rounded-none text-app-subtext font-semibold transition-colors ${tab === nextTab ? "bg-app-accent text-app-on-filled" : "text-app-text/90 hover:text-app-text"}`}
            >
              {nextTab === "recorded" ? m.sessions_tab_recorded() : m.sessions_tab_imported()}
            </Button>
          ))}
        </div>
      )}
      <AppInput
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={m.sessions_search_placeholder()}
        className="min-w-[200px] flex-1 @3xl/workspace:w-64 @3xl/workspace:flex-none"
      />
      <h1 className="text-app-title font-semibold text-app-text/90 shrink-0">
        {m.label_sessions()}
        {!isLoading && !sessionsError && (
          <span className="text-app-subtext text-app-text/90 font-normal ml-2">
            {filteredCount === sessions.length ? `${sessions.length} ${m.sessions_total()}` : `${filteredCount} ${m.sessions_filtered_count()} ${sessions.length}`}
          </span>
        )}
      </h1>
      <div className="flex items-center flex-wrap gap-2">
        {tab === "imported" && (
          <Button variant="app-outline" size="app-sm" onClick={() => setImportOpen(true)}>
            {m.sessions_import_motec()}
          </Button>
        )}
        {selectedLaps.size >= 2 &&
          (() => {
            const ids = [...selectedLaps];
            const selected = ids.map((id) => allLaps.find((lap) => lap.id === id)).filter((lap): lap is LapMeta => lap != null);
            const first = selected[0];
            const sameGroup = first?.trackOrdinal != null && first.carOrdinal != null && selected.length === ids.length && selected.every((lap) => lap.trackOrdinal === first.trackOrdinal && lap.carOrdinal === first.carOrdinal);
            if (!sameGroup) return null;
            return (
              <Button
                variant="app-primary"
                size="app-md"
                onClick={() => void navigate({ to: `${gameRoute}/analyse` as never, search: { track: first.trackOrdinal, car: first.carOrdinal, laps: ids.join(",") } as never })}
              >
                {m.label_analyse()} ({ids.length})
              </Button>
            );
          })()}
        {selectedLaps.size === 2 &&
          (() => {
            const ids = [...selectedLaps];
            const lapA = allLaps.find((lap) => lap.id === ids[0]);
            const lapB = allLaps.find((lap) => lap.id === ids[1]);
            if (!lapA || !lapB) return null;
            const sessionA = sessions.find((session) => session.id === lapA.sessionId);
            const sessionB = sessions.find((session) => session.id === lapB.sessionId);
            if (!sessionA || !sessionB || sessionA.trackOrdinal !== sessionB.trackOrdinal) return null;
            return (
              <Button
                variant="app-primary"
                size="app-md"
                onClick={() =>
                  navigate({
                    to: `${gameRoute}/compare` as never,
                    search: { track: sessionA.trackOrdinal, carA: sessionA.carOrdinal, carB: sessionB.carOrdinal, lapA: lapA.id, lapB: lapB.id } as never,
                  })
                }
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
  );
}
