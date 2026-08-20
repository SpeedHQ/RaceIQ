import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { useNavigate } from "@tanstack/react-router";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { useGameRoute } from "@/stores/game";
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
  const gameRoute = useGameRoute();
  const navigate = useNavigate();

  return (
    <div className="flex items-center flex-wrap gap-3">
      <div className="flex items-center rounded border border-app-border overflow-hidden shrink-0">
        {(["mine", "others"] as const satisfies readonly SessionsTab[]).map((nextTab) => (
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
            {nextTab === "mine" ? m.sessions_tab_mine() : m.sessions_tab_others()}
          </Button>
        ))}
      </div>
      <Button variant="app-outline" size="app-sm" onClick={() => setImportOpen(true)}>
        {m.sessions_import()}
      </Button>
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
        {selectedLaps.size >= 2 &&
          (() => {
            const selected = [...selectedLaps].map((id) => allLaps.find((lap) => lap.id === id)).filter((lap): lap is LapMeta => lap != null);
            if (selected.length !== selectedLaps.size) return null;
            const sessionById = new Map(sessions.map((session) => [session.id, session]));
            const selectedSessions = selected.map((lap) => sessionById.get(lap.sessionId));
            const trackOrdinal = selectedSessions[0]?.trackOrdinal;
            if (trackOrdinal == null || selectedSessions.some((session) => session?.trackOrdinal !== trackOrdinal)) return null;
            const [reference, ...compared] = selected;
            return (
              <Button
                variant="app-primary"
                size="app-md"
                onClick={() =>
                  navigate({
                    to: `${gameRoute}/compare` as never,
                    search: { track: trackOrdinal, carA: reference.carOrdinal, lapA: reference.id, laps: compared.map((lap) => lap.id).join(",") } as never,
                  })
                }
              >
                {m.compare_selected_laps({ count: selected.length })}
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
