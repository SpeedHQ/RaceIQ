import { Eye, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

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
  generationDisabled = false,
  deletionDisabled = false,
  disabledReason,
  onRegenerate,
  onDelete,
  deleteLabel,
  children,
}: {
  title: ReactNode;
  dotClass: string;
  hasResult: boolean;
  loading: boolean;
  error: string | null;
  runLabel: string;
  loadingLabel: string;
  retryLabel: string;
  onRun: () => void;
  onRetry: () => void;
  generationDisabled?: boolean;
  deletionDisabled?: boolean;
  disabledReason?: string;
  onRegenerate: () => void;
  onDelete: () => void;
  deleteLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <div className="flex min-w-0 flex-1 items-center gap-2 text-app-compact font-semibold text-app-text">{title}</div>
        {hasResult && (
          <>
            <Button type="button" variant="app-ghost" size="icon-sm" onClick={onRegenerate} disabled={generationDisabled} title={disabledReason ?? m.label_regenerate()} aria-label={m.label_regenerate()}>
              <RefreshCw />
            </Button>
            <Button type="button" variant="destructive-outline" size="icon-sm" onClick={onDelete} disabled={deletionDisabled} title={deleteLabel} aria-label={deleteLabel}>
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {!hasResult && !loading && !error && (
        <Button type="button" variant="app-primary" size="app-md" onClick={onRun} className="w-full" disabled={generationDisabled} title={disabledReason}>
          <Sparkles data-icon="inline-start" />
          {runLabel}
        </Button>
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
          <Button variant="app-outline" size="app-sm" onClick={onRetry} className="ml-2" disabled={generationDisabled} title={disabledReason}>
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
  const modalTabs: AnalysisModalTab[] = tabs?.length ? tabs : [{ key: "__title", label: m.label_ai_analysis() }];
  const interactive = (tabs?.length ?? 0) > 1;
  const selectedTab = activeTab ?? modalTabs[0]?.key;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60" className="max-h-[85vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 border-b border-app-border px-4 py-2.5">
          <DialogTitle className="sr-only">{m.label_ai_analysis()}</DialogTitle>
          <Sparkles className="size-3.5 text-ai-accent shrink-0" />
          <Tabs value={selectedTab} onValueChange={interactive ? onTabChange : undefined} className="contents">
            <TabsList className="flex items-center gap-2">
              {modalTabs.map((tab) => {
                const active = tab.key === selectedTab;
                return (
                  <TabsTrigger
                    key={tab.key}
                    value={tab.key}
                    disabled={!interactive}
                    className={`flex items-center gap-1.5 px-2 py-1 text-app-compact font-semibold uppercase tracking-wider ${active ? "data-[active]:bg-app-border-input/30 data-[active]:text-app-text" : "data-[active]:bg-transparent data-[active]:text-app-text-muted"} ${interactive ? "hover:bg-app-surface-hover/20" : "px-0 disabled:opacity-100"}`}
                  >
                    {tab.label}
                    {tab.badge !== undefined && (
                      <Badge variant="neutral" size="compact">
                        {tab.badge}
                      </Badge>
                    )}
                    {tab.flag && (
                      <Badge variant="ai-status" size="compact">
                        {tab.flag}
                      </Badge>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {subtitle && <span className="text-app-compact text-app-text-secondary truncate ml-2">{subtitle}</span>}
          <Button variant="close-action" size="icon-sm" onClick={onClose} className="ml-auto shrink-0" aria-label={m.common_close()}>
            <X className="size-4" />
          </Button>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
