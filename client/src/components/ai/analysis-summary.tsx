import { Eye, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { m } from "@/paraglide/messages";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-status-success/10 border border-status-success/30 hover:bg-status-success/15 transition-colors text-left"
    >
      <Sparkles className="size-3 text-status-success shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-app-caption font-semibold text-status-success uppercase tracking-wider">{title ?? m.compare_analysis_complete()}</div>
        <div className="text-app-micro text-app-text-muted font-mono">{detail}</div>
      </div>
      <span className="flex items-center gap-1 text-app-caption text-app-text-secondary shrink-0">
        <Eye className="size-3" /> {m.label_view()}
      </span>
    </button>
  );
}

export interface AnalysisModalTab {
  key: string;
  label: string;
  /** Small count pill after the label, e.g. the number of setup entries. */
  badge?: number;
  /** Amber "best guess" style flag, used when no tune is linked. */
  flag?: string;
}

/**
 * Portal modal chrome for whatever an AnalysisSummaryRow opens — backdrop
 * click-to-close, header with title and optional subtitle, scrollable body.
 * Optional tabs switch the body between sections (analysis / setup) instead of
 * stacking a second modal on top of this one.
 */
export function AnalysisModalShell({
  subtitle,
  onClose,
  tabs,
  activeTab,
  onTabChange,
  children,
}: {
  subtitle?: string;
  onClose: () => void;
  tabs?: AnalysisModalTab[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" showCloseButton={false} className="max-h-[85vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 border-b border-app-border px-4 py-2.5">
          <Sparkles className="size-3.5 text-ai-accent shrink-0" />
          <DialogTitle className="sr-only">{m.label_ai_analysis()}</DialogTitle>
          {(tabs?.length ? tabs : [{ key: "__title", label: m.label_ai_analysis() } as AnalysisModalTab]).map((tab) => {
            const active = !tabs?.length || tab.key === activeTab;
            const interactive = (tabs?.length ?? 0) > 1;
            return (
              <button
                key={tab.key}
                type="button"
                disabled={!interactive}
                onClick={() => onTabChange?.(tab.key)}
                className={`flex items-center gap-1.5 rounded px-2 py-1 text-app-compact font-semibold uppercase tracking-wider transition-colors ${
                  active ? "text-app-text" : "text-app-text-muted hover:text-app-text-secondary"
                } ${interactive ? (active ? "bg-app-border-input/30" : "hover:bg-app-surface-hover/20") : "px-0"}`}
              >
                {tab.label}
                {tab.badge !== undefined && <span className="text-app-micro font-mono px-1.5 py-0.5 rounded bg-app-border-input/30 text-app-text-secondary">{tab.badge}</span>}
                {tab.flag && <span className="text-app-nano font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-ai-accent/15 text-ai-accent border border-ai-accent/20">{tab.flag}</span>}
              </button>
            );
          })}
          {subtitle && <span className="text-app-compact text-app-text-secondary truncate ml-2">{subtitle}</span>}
          <button type="button" onClick={onClose} className="ml-auto pl-2 text-app-text-muted hover:text-app-text shrink-0" aria-label={m.common_close()}>
            <X className="size-4" />
          </button>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
