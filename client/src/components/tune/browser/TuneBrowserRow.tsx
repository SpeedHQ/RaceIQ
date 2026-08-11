import { type KeyboardEvent, type ReactNode, useState } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "@/components/tune/tune-constants";
import { TD, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
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
    <>
      <TRow aria-expanded={isOpen} onClick={onToggle} onKeyDown={handleKeyDown} tabIndex={0}>
        <TD align="center" numeric tone={rank === 1 && hasTime ? "accent" : "muted"}>
          <span className="text-sm font-bold">{rank}</span>
        </TD>
        <TD tone="primary">
          <span className="block min-w-0">
            <span className="block text-app-body font-semibold truncate">{row.name}</span>
            <span className="block text-app-caption text-app-text-muted mt-1">{SOURCE_LABEL[row.source]()}</span>
          </span>
        </TD>
        <TD showFrom="workspace-md" truncate="wide">
          {carName}
        </TD>
        <TD showFrom="workspace-md" tone={trackName ? "default" : "dim"} truncate="wide">
          {trackName ?? "—"}
        </TD>
        <TD showFrom="workspace-md">
          {row.category && (
            <span className={`inline-block text-app-caption font-semibold uppercase px-1.5 py-0.5 rounded truncate ${CATEGORY_COLORS[row.category] ?? "bg-app-surface-alt text-app-text-muted"}`}>
              {catLabel}
            </span>
          )}
        </TD>
        <TD showFrom="workspace-md" truncate="wide">
          {row.author}
        </TD>
        <TD align="end" numeric tone={hasTime ? "primary" : "dim"}>
          <span className={hasTime ? "text-(--lap-pace-average)" : undefined}>
            {hasTime ? row.lapTimeRaw : "—"}
            <span className="mt-0.5 hidden text-app-nano uppercase tracking-wide text-app-text-dim @3xl/workspace:block">
              {hasTime ? (row.lapTimeTrack ?? m.browser_lap_label()) : m.browser_no_time()}
            </span>
          </span>
        </TD>
        <TD align="center" showFrom="workspace-md" tone={isOpen ? "accent" : "dim"}>
          <span className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
        </TD>
      </TRow>
      {isOpen && (
        <TRow variant="static">
          <TD colSpan={8} tone="primary">
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
                      {!confirmDelete ? (
                        <Button type="button" className="text-app-compact uppercase tracking-wide px-4 py-2 rounded border border-app-border text-status-danger" onClick={() => setConfirmDelete(true)}>
                          {m.common_delete()}
                        </Button>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span className="text-app-compact text-status-danger uppercase">{m.browser_confirm_delete()}</span>
                          <Button type="button" className="text-app-compact uppercase tracking-wide px-3 py-2 rounded bg-status-danger/20 text-status-danger" onClick={() => onDelete?.(row)}>
                            {m.tune_yes()}
                          </Button>
                          <Button type="button" className="text-app-compact uppercase tracking-wide px-3 py-2 rounded text-app-text-muted hover:text-app-text" onClick={() => setConfirmDelete(false)}>
                            {m.browser_no()}
                          </Button>
                        </span>
                      )}
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
    </>
  );
}
