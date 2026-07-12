import { TuneSettingsPanel } from "@/components/tune/TuneSettingsPanel";
import { CATEGORY_LABELS } from "@/components/tune/tune-constants";
import type { TuneRow } from "./types";

const SOURCE_LABEL: Record<TuneRow["source"], string> = {
  builtin: "Built-in",
  community: "Community",
  user: "Yours",
};

export interface TuneBrowserRowProps {
  row: TuneRow;
  rank: number;
  isOpen: boolean;
  onToggle: () => void;
  onClone: (row: TuneRow) => void;
  onEdit: (row: TuneRow) => void;
  onDelete: (row: TuneRow) => void;
}

function fmt(_sec: number | null, raw: string | null): string {
  return raw ?? "—";
}

export function TuneBrowserRow({ row, rank, isOpen, onToggle, onClone, onEdit, onDelete }: TuneBrowserRowProps) {
  const hasTime = row.lapTimeSec != null;
  const isUser = row.source === "user";
  return (
    <div className={`rounded-lg border ${isOpen ? "border-app-accent/40 bg-app-surface-alt" : "border-app-border bg-app-surface"} transition-colors`}>
      <button type="button" onClick={onToggle} className="w-full grid grid-cols-[28px_1fr_auto] sm:grid-cols-[32px_1fr_minmax(120px,150px)_96px_92px_20px] items-center gap-3 px-3 py-3 text-left">
        <span className={`text-sm font-bold text-center ${rank === 1 && hasTime ? "text-app-accent" : "text-app-text-muted"}`}>{rank}</span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-app-text truncate">{row.name}</span>
          <span className="block text-[10px] text-app-text-muted mt-1">
            {SOURCE_LABEL[row.source]}
            {row.category ? ` · ${CATEGORY_LABELS[row.category] ?? row.category}` : ""}
          </span>
        </span>
        <span className="hidden sm:block text-[13px] text-app-text truncate">{row.author}</span>
        <span className="hidden sm:block justify-self-end text-[9px] tracking-wide px-2 py-1 rounded border border-app-border text-app-text-muted uppercase">
          {CATEGORY_LABELS[row.category] ?? row.category}
        </span>
        <span className={`justify-self-end font-mono text-[13px] tabular-nums ${hasTime ? "text-amber-400" : "text-app-text-muted"}`}>
          {fmt(row.lapTimeSec, row.lapTimeRaw)}
          {hasTime && row.lapTimeTrack && <span className="block text-[8px] tracking-wide text-app-text-muted">{row.lapTimeTrack}</span>}
        </span>
        <span className={`hidden sm:block text-app-text-muted transition-transform ${isOpen ? "rotate-90 text-app-accent" : ""}`}>›</span>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 pt-1 space-y-3">
          {row.description && <p className="text-xs text-app-text-muted leading-relaxed whitespace-pre-line">{row.description}</p>}
          <TuneSettingsPanel settings={row.settings} />
          <div className="flex gap-2">
            {isUser ? (
              <>
                <button type="button" onClick={() => onEdit(row)} className="text-xs px-4 py-2 rounded bg-app-accent text-white">
                  Edit
                </button>
                <button type="button" onClick={() => onDelete(row)} className="text-xs px-4 py-2 rounded border border-app-border text-app-text-secondary">
                  Delete
                </button>
              </>
            ) : (
              <button type="button" onClick={() => onClone(row)} className="text-xs px-4 py-2 rounded bg-app-accent text-white">
                Clone to garage
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
