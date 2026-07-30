import { Eye, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { m } from "@/paraglide/messages";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Shared completed-analysis summary row. */
export function AnalysisSummaryRow({ title, detail, onView }: { title?: string; detail: string; onView: () => void }) {
  return (
    <Button variant="analysis-summary" size="app-sm" onClick={onView} className="min-w-0 flex-1">
      <Sparkles className="size-3 shrink-0 text-status-success" />
      <div className="min-w-0 flex-1">
        <div className="text-app-caption font-semibold uppercase tracking-wider text-status-success">{title ?? m.compare_analysis_complete()}</div>
        <div className="font-mono text-app-micro text-app-text-muted">{detail}</div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-app-caption text-app-text-secondary">
        <Eye className="size-3" /> {m.label_view()}
      </span>
    </Button>
  );
}

/** Shared card shell for lap and comparison analysis results. */
export function AnalysisResultCard({
  title,
  dotClass,
  hasResult,
  loading,
  error,
  runLabel,
  loadingLabel,
  retryLabel,
  onRun,
  onRetry,
  actionsDisabled = false,
  onRegenerate,
  onDelete,
  deleteLabel,
  children,
}: {
  title: string;
  dotClass: string;
  hasResult: boolean;
  loading: boolean;
  error: string | null;
  runLabel: string;
  loadingLabel: string;
  retryLabel: string;
  onRun: () => void;
  onRetry: () => void;
  actionsDisabled?: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
  deleteLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className="text-app-compact font-semibold text-app-text truncate flex-1">{title}</span>
        {hasResult && (
          <>
            <button
              type="button"
              onClick={onRegenerate}
              disabled={actionsDisabled}
              className="text-app-text-muted hover:text-app-text disabled:opacity-40"
              title={m.label_regenerate()}
              aria-label={m.label_regenerate()}
            >
              <RefreshCw className="size-3" />
            </button>
            <button type="button" onClick={onDelete} disabled={actionsDisabled} className="text-app-text-muted hover:text-status-danger disabled:opacity-40" title={deleteLabel} aria-label={deleteLabel}>
              <Trash2 className="size-3" />
            </button>
          </>
        )}
      </div>
      {!hasResult && !loading && !error && (
        <button type="button" onClick={onRun} className="w-full flex items-center justify-center gap-1.5 text-app-compact px-2 py-1.5 rounded bg-app-accent hover:bg-app-accent-hover text-app-on-filled transition-colors">
          <Sparkles className="size-3" />
          {runLabel}
        </button>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-app-caption text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          {loadingLabel}
        </div>
      )}
      {error && (
        <div className="text-app-caption text-status-danger mb-1">
          {error}
          <Button variant="app-outline" size="app-sm" onClick={onRetry} className="ml-2">
            {retryLabel}
          </Button>
        </div>
      )}
      {hasResult && children}
    </div>
  );
}

export interface AnalysisModalTab {
  key: string;
  label: string;
  badge?: number;
  flag?: string;
}

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
