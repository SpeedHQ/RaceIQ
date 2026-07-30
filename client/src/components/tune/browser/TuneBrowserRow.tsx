import { type KeyboardEvent, type ReactNode, useState } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "@/components/tune/tune-constants";
import { m } from "@/paraglide/messages";
import type { TuneRow } from "./types";
import { Button } from "@/components/ui/button";
import { TD, TRow } from "@/components/ui/AppTable";

// Resolve at render time — calling m.*() at module scope would freeze the locale.
const SOURCE_LABEL: Record<TuneRow["source"], () => string> = {
  community: () => m.browser_community(),
  user: () => m.tune_source_yours(),
};

// Shared responsive grid: mobile shows #, name, lap, chevron; sm+ adds car + track + category + author.
export const TUNE_GRID = "grid grid-cols-[26px_1fr_66px_26px] items-center gap-2.5 @3xl/workspace:grid-cols-[34px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_88px_minmax(90px,120px)_84px_30px]";

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
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div className={`border-b border-app-border ${isOpen ? "bg-app-surface-alt" : "bg-app-surface even:bg-app-surface-alt"}`}>
      <button type="button" className={`${TUNE_GRID} w-full text-left px-3 py-3`} onClick={onToggle}>
        <span className={`text-sm font-bold text-center ${rank === 1 && hasTime ? "text-app-accent" : "text-app-text-muted"}`}>{rank}</span>
        <span className="min-w-0">
          <span className="block text-app-body font-semibold truncate">{row.name}</span>
          <span className="block text-app-caption text-app-text-muted mt-1">{SOURCE_LABEL[row.source]()}</span>
        </span>
        <span className="hidden min-w-0 truncate text-app-detail text-app-text-secondary @3xl/workspace:block">{carName}</span>
        <span className={`hidden min-w-0 truncate text-app-detail @3xl/workspace:block ${trackName ? "text-app-accent" : "text-app-text-dim"}`}>{trackName ?? "—"}</span>
        <span className="hidden min-w-0 @3xl/workspace:block">
          {row.category && (
            <span className={`inline-block text-app-caption font-semibold uppercase px-1.5 py-0.5 rounded truncate ${CATEGORY_COLORS[row.category] ?? "bg-app-surface-alt text-app-text-muted"}`}>
              {catLabel}
            </span>
          )}
        </span>
        <span className="hidden min-w-0 truncate text-app-detail @3xl/workspace:block">{row.author}</span>
        <span className={`justify-self-end font-mono text-app-detail tabular-nums text-right ${hasTime ? "text-(--lap-pace-average)" : "text-app-text-dim"}`}>
          {hasTime ? row.lapTimeRaw : "—"}
          <span className="mt-0.5 hidden text-app-nano text-app-text-dim uppercase tracking-wide @3xl/workspace:block">
            {hasTime ? (row.lapTimeTrack ?? m.browser_lap_label()) : m.browser_no_time()}
          </span>
        </span>
        <span className={`hidden text-center text-app-text-dim transition-transform @3xl/workspace:block ${isOpen ? "rotate-90 text-app-accent" : ""}`}>›</span>
      </button>
      {isOpen && (
        <div className="px-4 pt-1 pb-4 @3xl/workspace:pl-14">
          {row.description && <p className="text-xs text-app-text-muted leading-relaxed whitespace-pre-line mb-3.5 max-w-[70ch]">{row.description}</p>}
          {renderSettings(row)}
          {!readOnly && (
            <div className="flex gap-2 mt-3.5">
              {isUser ? (
                <>
                  <button type="button" className="text-app-compact uppercase tracking-wide px-4 py-2 rounded bg-app-accent text-app-on-filled font-bold" onClick={() => onEdit?.(row)}>
                    {m.common_edit()}
                  </button>
                  {onDuplicate && (
                    <button
                      type="button"
                      className="text-app-compact uppercase tracking-wide px-4 py-2 rounded border border-app-border text-app-accent disabled:opacity-50"
                      onClick={() => onDuplicate(row)}
                      disabled={isDuplicating}
                    >
                      {isDuplicating ? "…" : m.tune_duplicate()}
                    </button>
                  )}
                  {!confirmDelete ? (
                    <button type="button" className="text-app-compact uppercase tracking-wide px-4 py-2 rounded border border-app-border text-status-danger" onClick={() => setConfirmDelete(true)}>
                      {m.common_delete()}
                    </button>
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
    </>
  );
}
