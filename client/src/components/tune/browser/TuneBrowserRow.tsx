import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { CATEGORY_COLORS } from "@/components/tune/tune-constants";
import { TableCell as TD, TableRow as TRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { parseUtcTimestamp } from "@/lib/utc-date";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";
import type { TuneRow } from "./types";

// Resolve at render time — calling m.*() at module scope would freeze the locale.
const SOURCE_LABEL: Record<TuneRow["source"], () => string> = {
  community: () => m.browser_community(),
  user: () => m.tune_source_yours(),
};

export interface TuneBrowserRowProps {
  row: TuneRow;
  rank: number;
  showLapTime: boolean;
  carName: string;
  trackName: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onClone?: (row: TuneRow) => void;
  onEdit?: (row: TuneRow) => void;
  onDuplicate?: (row: TuneRow) => void;
  onDelete?: (row: TuneRow) => Promise<void>;
  isDuplicating?: boolean;
  renderSettings: (row: TuneRow) => ReactNode;
  /** Read-only mode hides the per-row owner/clone actions. */
  readOnly?: boolean;
}

export function TuneBrowserRow({ row, rank, showLapTime, carName, trackName, isOpen, onToggle, onClone, onEdit, onDelete, onDuplicate, isDuplicating, renderSettings, readOnly }: TuneBrowserRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { data: usage, isFetching: usageLoading, error: usageError } = useQuery({
    queryKey: ["tune-usage", row.dbId],
    queryFn: async () => rpcJson<{ sessions: Array<{sessionId:number; gameId:string; createdAt:string; laps:Array<{id:number; lapNumber:number}>}>; assignments: Array<{gameId:string;carOrdinal:number;trackOrdinal:number}> }>(await client.api.tunes[":id"].usage.$get({ param: { id: String(row.dbId) } })),
    enabled: confirmDelete && row.dbId != null,
    retry: false,
  });
  const hasTime = showLapTime && row.lapTimeSec != null;
  const isUser = row.source === "user";
  const catLabel =
    row.category === "circuit" ? m.tune_category_circuit() : row.category === "wet" ? m.tune_category_wet() : row.category === "low-drag" ? m.tune_category_low_drag() : row.category === "stable" ? m.tune_category_stable() : row.category === "track-specific" ? m.tune_category_track_specific() : row.category;
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  return (
    <>
      <TRow aria-expanded={isOpen} onClick={onToggle} onKeyDown={handleKeyDown} tabIndex={0} className="group/row relative cursor-pointer transition-colors hover:bg-app-surface-hover/50">
        <TD className={`px-3 py-2 text-center font-mono tabular-nums ${rank === 1 && hasTime ? "text-app-accent" : "text-app-text-muted"}`}>
          <span className="text-sm font-bold">{rank}</span>
        </TD>
        <TD className="px-3 py-2 text-app-text">
          <span className="block min-w-0">
            <span className="block text-app-body font-semibold truncate">{row.name}</span>
            <span className="block text-app-caption text-app-text-muted mt-1">{SOURCE_LABEL[row.source]()}</span>
          </span>
        </TD>
        <TD className="hidden @3xl/workspace:table-cell max-w-[200px] truncate px-3 py-2 text-app-text-secondary">
          {carName}
        </TD>
        <TD className={`hidden @3xl/workspace:table-cell max-w-[200px] truncate px-3 py-2 ${trackName ? "text-app-text-secondary" : "text-app-text-dim"}`}>
          {trackName ?? "—"}
        </TD>
        <TD className="hidden @3xl/workspace:table-cell px-3 py-2 text-app-text-secondary">
          {row.category && (
            <span className={`inline-block text-app-caption font-semibold uppercase px-1.5 py-0.5 rounded truncate ${CATEGORY_COLORS[row.category] ?? "bg-app-surface-alt text-app-text-muted"}`}>
              {catLabel}
            </span>
          )}
        </TD>
        <TD className="hidden @3xl/workspace:table-cell max-w-[200px] truncate px-3 py-2 text-app-text-secondary">
          {row.author}
        </TD>
        {showLapTime && (
          <TD className={`px-3 py-2 text-right font-mono tabular-nums ${hasTime ? "text-app-text" : "text-app-text-dim"}`}>
            <span className={hasTime ? "text-(--lap-pace-average)" : undefined}>
              {hasTime ? row.lapTimeRaw : "—"}
              <span className="mt-0.5 hidden text-app-nano uppercase tracking-wide text-app-text-dim @3xl/workspace:block">
                {hasTime ? (isUser ? m.tunes_best_lap() : (row.lapTimeTrack ?? m.browser_lap_label())) : m.browser_no_time()}
              </span>
            </span>
          </TD>
        )}
        <TD className={`hidden @3xl/workspace:table-cell px-3 py-2 text-center ${isOpen ? "text-app-accent" : "text-app-text-dim"}`}>
          <span className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
        </TD>
      </TRow>
      {isOpen && (
        <TRow className="relative transition-colors">
          <TD colSpan={showLapTime ? 8 : 7} className="px-3 py-2 text-app-text">
            <div className="px-1 pb-2 pt-1 @3xl/workspace:px-8">
              {row.description && <p className="text-xs text-app-text-muted leading-relaxed whitespace-pre-line mb-3.5 max-w-[70ch]">{row.description}</p>}
              {renderSettings(row)}
              {!readOnly && (
                <div className="mt-3.5 flex flex-wrap gap-2">
                  {isUser ? (
                    <>
                      <Button type="button" className="text-app-compact uppercase tracking-wide px-4 py-2 rounded bg-app-accent text-app-on-filled font-bold" onClick={() => onEdit?.(row)}>
                        {m.common_edit()}
                      </Button>
                      {onDuplicate && (
                        <Button
                          type="button"
                          className="text-app-compact uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-accent disabled:opacity-50"
                          onClick={() => onDuplicate(row)}
                          disabled={isDuplicating}
                        >
                          {isDuplicating ? "…" : m.tune_duplicate()}
                        </Button>
                      )}
                      <Button type="button" className="text-app-compact uppercase tracking-wide px-4 py-2 rounded border border-app-border text-status-danger" onClick={() => { setDeleteError(null); setConfirmDelete(true); }} disabled={row.dbId == null}>
                        {m.common_delete()}
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="app-primary" size="app-md" onClick={() => onClone?.(row)}>
                      {m.browser_clone_garage()}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </TD>
        </TRow>
      )}
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open && !isDeleting) setConfirmDelete(false); }}>
        <DialogContent size="md" overlayClassName="bg-app-bg/60">
          <DialogHeader><DialogTitle>{m.tunebrowserrow_delete_title()}</DialogTitle><DialogDescription>{m.tunebrowserrow_delete_description({ name: row.name })}</DialogDescription></DialogHeader>
          {usageLoading && <p>{m.tunebrowserrow_usage_loading()}</p>}
          {usageError && <p role="alert" className="text-status-danger">{m.tunebrowserrow_usage_error()}</p>}
          {usage && (usage.sessions.length || usage.assignments.length) > 0 ? <div className="max-h-64 space-y-3 overflow-y-auto text-sm">
            <p>{m.tunebrowserrow_in_use_warning()}</p>
            {usage.sessions.map((session) => <div key={session.sessionId}>
              <p>{m.tunebrowserrow_session({ id: String(session.sessionId), date: parseUtcTimestamp(session.createdAt).toLocaleString(getLocale()) })}</p>
              <p className="text-app-text-muted">{m.tunebrowserrow_laps({ laps: session.laps.map((lap) => lap.lapNumber).join(", ") || "—" })}</p>
            </div>)}
            {usage.assignments.length > 0 && <p>{m.tunebrowserrow_assignments({ count: String(usage.assignments.length) })}</p>}
          </div> : usage && <p className="text-sm text-app-text-muted">{m.tunebrowserrow_unlinked_warning()}</p>}
          {deleteError && <p role="alert" className="text-status-danger">{deleteError}</p>}
          <DialogFooter>
            <Button type="button" variant="app-outline" onClick={() => setConfirmDelete(false)} disabled={isDeleting}>{m.common_cancel()}</Button>
            <Button type="button" variant="app-danger" disabled={!usage || usageLoading || !!usageError || isDeleting} onClick={async () => {
              if (!onDelete) return;
              setIsDeleting(true); setDeleteError(null);
              try { await onDelete(row); setConfirmDelete(false); }
              catch (error) { setDeleteError(error instanceof Error ? error.message : String(error)); }
              finally { setIsDeleting(false); }
            }}>{isDeleting ? m.tunebrowserrow_deleting() : m.common_delete()}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
