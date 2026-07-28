import { Eye, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { m } from "@/paraglide/messages";

/**
 * Collapsed representation of a finished analysis: one row with a headline and
 * a counts line, click to open the full breakdown. Shared by the compare panel
 * (one row per lap, plus the inputs comparison) and the analyse panel (one row
 * for the lap being analysed) so both pages collapse the same way.
 */
export function AnalysisSummaryRow({ title, detail, onView }: { title?: string; detail: string; onView: () => void }) {
  return (
    <button
      type="button"
      onClick={onView}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/15 transition-colors text-left"
    >
      <Sparkles className="size-3 text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-semibold text-emerald-300 uppercase tracking-wider">{title ?? m.compare_analysis_complete()}</div>
        <div className="text-[9px] text-app-text-muted font-mono">{detail}</div>
      </div>
      <span className="flex items-center gap-1 text-[10px] text-app-text-secondary shrink-0">
        <Eye className="size-3" /> {m.label_view()}
      </span>
    </button>
  );
}

/**
 * Portal modal chrome for whatever an AnalysisSummaryRow opens — backdrop
 * click-to-close, header with title and optional subtitle, scrollable body.
 */
export function AnalysisModalShell({ subtitle, onClose, children }: { subtitle?: string; onClose: () => void; children: ReactNode }) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[640px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="size-3.5 text-amber-400" />
            <span className="text-[11px] font-semibold text-app-text uppercase tracking-wider shrink-0">{m.label_ai_analysis()}</span>
            {subtitle && <span className="text-[11px] text-app-text-secondary truncate">{subtitle}</span>}
          </div>
          <button type="button" onClick={onClose} className="text-app-text-muted hover:text-app-text shrink-0">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
