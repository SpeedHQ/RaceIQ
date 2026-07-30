import { type ReactNode, useState } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "@/components/tune/tune-constants";
import { m } from "@/paraglide/messages";
import type { TuneRow } from "./types";

// Resolve at render time — calling m.*() at module scope would freeze the locale.
const SOURCE_LABEL: Record<TuneRow["source"], () => string> = {
  community: () => m.browser_community(),
  user: () => m.tune_source_yours(),
};

// Shared responsive grid: mobile shows #, name, lap, chevron; sm+ adds car + track + category + author.
export const TUNE_GRID = "grid grid-cols-[26px_1fr_66px_26px] sm:grid-cols-[34px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_88px_minmax(90px,120px)_84px_30px] items-center gap-2.5";

export interface TuneBrowserRowProps {
  row: TuneRow;
  rank: number;
  carName: string;
  trackName: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onClone?: (row: TuneRow) => void;
  onEdit?: (row: TuneRow) => void;
  onDelete?: (row: TuneRow) => void;
  onDuplicate?: (row: TuneRow) => void;
  isDuplicating?: boolean;
  renderSettings: (row: TuneRow) => ReactNode;
  /** Read-only mode hides the per-row owner/clone actions. */
  readOnly?: boolean;
}

export function TuneBrowserRow({ row, rank, carName, trackName, isOpen, onToggle, onClone, onEdit, onDelete, onDuplicate, isDuplicating, renderSettings, readOnly }: TuneBrowserRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasTime = row.lapTimeSec != null;
  const isUser = row.source === "user";
  const catLabel = CATEGORY_LABELS[row.category] ?? row.category;

  return (
    <div className={`border-b border-app-border ${isOpen ? "bg-app-surface-alt" : "bg-app-surface even:bg-app-surface-alt"}`}>
      <button type="button" className={`${TUNE_GRID} w-full text-left px-3 py-3`} onClick={onToggle}>
        <span className={`text-sm font-bold text-center ${rank === 1 && hasTime ? "text-app-accent" : "text-app-text-muted"}`}>{rank}</span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold truncate">{row.name}</span>
          <span className="block text-[10px] text-app-text-muted mt-1">{SOURCE_LABEL[row.source]()}</span>
        </span>
        <span className="hidden sm:block text-[13px] text-app-text-secondary min-w-0 truncate">{carName}</span>
        <span className={`hidden sm:block text-[13px] min-w-0 truncate ${trackName ? "text-app-accent" : "text-app-text-dim"}`}>{trackName ?? "—"}</span>
        <span className="hidden sm:block min-w-0">
          {row.category && (
            <span className={`inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded truncate ${CATEGORY_COLORS[row.category] ?? "bg-app-surface-alt text-app-text-muted"}`}>
              {catLabel}
            </span>
          )}
        </span>
        <span className="hidden sm:block text-[13px] min-w-0 truncate">{row.author}</span>
        <span className={`justify-self-end font-mono text-[13px] tabular-nums text-right ${hasTime ? "text-(--lap-pace-average)" : "text-app-text-dim"}`}>
          {hasTime ? row.lapTimeRaw : "—"}
          <span className="hidden sm:block text-[8px] uppercase tracking-wide text-app-text-dim mt-0.5">{hasTime ? (row.lapTimeTrack ?? m.browser_lap_label()) : m.browser_no_time()}</span>
        </span>
        <span className={`hidden sm:block text-center text-app-text-dim transition-transform ${isOpen ? "rotate-90 text-app-accent" : ""}`}>›</span>
      </button>
      {isOpen && (
        <div className="px-4 sm:pl-14 pb-4 pt-1">
          {row.description && <p className="text-xs text-app-text-muted leading-relaxed whitespace-pre-line mb-3.5 max-w-[70ch]">{row.description}</p>}
          {renderSettings(row)}
          {!readOnly && (
            <div className="flex gap-2 mt-3.5">
              {isUser ? (
                <>
                  <button type="button" className="text-[11px] uppercase tracking-wide px-4 py-2 rounded bg-app-accent text-app-on-filled font-bold" onClick={() => onEdit?.(row)}>
                    {m.common_edit()}
                  </button>
                  {onDuplicate && (
                    <button
                      type="button"
                      className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-accent disabled:opacity-50"
                      onClick={() => onDuplicate(row)}
                      disabled={isDuplicating}
                    >
                      {isDuplicating ? "…" : m.tune_duplicate()}
                    </button>
                  )}
                  {!confirmDelete ? (
                    <button type="button" className="text-[11px] uppercase tracking-wide px-4 py-2 rounded border border-app-border text-status-danger" onClick={() => setConfirmDelete(true)}>
                      {m.common_delete()}
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11px] text-status-danger uppercase">{m.browser_confirm_delete()}</span>
                      <button type="button" className="text-[11px] uppercase tracking-wide px-3 py-2 rounded bg-status-danger/20 text-status-danger" onClick={() => onDelete?.(row)}>
                        {m.tune_yes()}
                      </button>
                      <button type="button" className="text-[11px] uppercase tracking-wide px-3 py-2 rounded text-app-text-muted hover:text-app-text" onClick={() => setConfirmDelete(false)}>
                        {m.browser_no()}
                      </button>
                    </span>
                  )}
                </>
              ) : (
                <button type="button" className="text-[11px] uppercase tracking-wide px-4 py-2 rounded bg-app-accent text-app-on-filled font-bold" onClick={() => onClone?.(row)}>
                  {m.browser_clone_garage()}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
