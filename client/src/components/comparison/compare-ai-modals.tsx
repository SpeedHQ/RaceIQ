import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { AnalysisDisplay } from "@/components/ai/analysis-display";
import { SetupList } from "@/components/ai/analysis-primitives";
import { AnalysisModalShell } from "@/components/ai/analysis-summary";
import type { AnalysisData } from "@/components/ai/analysis-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import type { AnalysisSummary, InputsAnalysis } from "./compare-ai-types";

const SEVERITY_DOT = {
  minor: "bg-app-text-dim",
  moderate: "bg-(--severity-caution)",
  major: "bg-(--severity-critical)",
} as const;
export function InputsModal({
  analysis,
  onClose,
  trackSegments,
  onJumpToFrac,
}: {
  analysis: InputsAnalysis;
  onClose: () => void;
  trackSegments?: { name: string; startFrac: number; endFrac: number }[];
  onJumpToFrac?: (frac: number) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="flex flex-col overflow-hidden">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-ai-accent" />
            <DialogTitle className="text-app-compact font-semibold text-app-text uppercase tracking-wider">{m.compare_inputs_comparison()}</DialogTitle>
          </div>
          <Button type="button" onClick={onClose} className="text-app-text-muted hover:text-app-text" aria-label={m.common_close()}>
            <X className="size-4" />
          </Button>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {analysis.verdict && <p className="text-app-label text-app-text leading-relaxed">{analysis.verdict}</p>}

          {analysis.segments?.length > 0 && (
            <div className="space-y-2">
              {analysis.segments.map((seg) => {
                // Resolve the AI-named segment to a track position so clicking
                // the card moves the chart/track cursor to that segment.
                const match = trackSegments?.find((s) => {
                  const sn = s.name.toLowerCase();
                  const gn = seg.name.toLowerCase();
                  return sn === gn || sn.includes(gn) || gn.includes(sn);
                });
                const clickable = !!(match && onJumpToFrac);
                return (
                  // oxlint-disable-next-line a11y/noStaticElementInteractions: optional jump-to-segment affordance, non-essential
                  <div
                    key={`${seg.name}-${seg.type ?? ""}-${seg.deltaSeconds ?? ""}`}
                    onClick={() => match && onJumpToFrac?.((match.startFrac + match.endFrac) / 2)}
                    className={`rounded-lg border border-app-border-input/40 px-2.5 py-2 ${clickable ? "cursor-pointer hover:border-app-accent/40 hover:bg-app-surface-hover/60 transition-colors" : ""}`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`size-1.5 rounded-full ${SEVERITY_DOT[seg.severity] ?? SEVERITY_DOT.minor}`} />
                      <span className="text-app-compact font-semibold text-app-text">{seg.name}</span>
                      {seg.type && <span className="text-app-micro uppercase tracking-wider text-app-text-muted">{seg.type}</span>}
                      {typeof seg.deltaSeconds === "number" && (
                        <span
                          className={`ml-auto text-app-caption font-mono ${seg.deltaSeconds > 0.05 ? "text-(--delta-loss)" : seg.deltaSeconds < -0.05 ? "text-(--delta-gain)" : "text-app-text-muted"}`}
                        >
                          {seg.deltaSeconds >= 0 ? "+" : ""}
                          {seg.deltaSeconds.toFixed(3)}s
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-1 text-app-compact text-app-text-secondary">
                      <div>
                        <span className="text-(--ch-throttle)/70 font-medium">{m.compare_throttle()}</span> {seg.throttle}
                      </div>
                      <div>
                        <span className="text-(--ch-brake)/70 font-medium">{m.compare_brake()}</span> {seg.brake}
                      </div>
                      <div>
                        <span className="text-(--ch-steer)/70 font-medium">{m.compare_steering()}</span> {seg.steering}
                      </div>
                    </div>
                    {seg.action && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded bg-ai-accent/10 border border-ai-accent/30 px-2 py-1.5">
                        <Sparkles className="size-3 text-ai-accent shrink-0 mt-0.5" />
                        <span className="text-app-compact text-ai-accent leading-snug">{seg.action}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {analysis.coaching?.length > 0 && (
            <div>
              <div className="text-app-caption font-semibold text-app-text uppercase tracking-wider mb-1">{m.label_coaching()}</div>
              <div className="space-y-1.5">
                {analysis.coaching.map((c) => (
                  <div key={`${c.targetLap}-${c.tip}`} className="rounded border border-app-border-input/40 px-2 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-app-micro font-semibold uppercase tracking-wider px-1 py-0.5 rounded ${
                          c.targetLap === "A"
                            ? "bg-(--comparison-lap-a)/15 text-(--comparison-lap-a) border border-(--comparison-lap-a)/30"
                            : "bg-(--comparison-lap-b)/15 text-(--comparison-lap-b) border border-(--comparison-lap-b)/30"
                        }`}
                      >
                        {m.compare_lap_label()} {c.targetLap}
                      </span>
                      <span className="text-app-compact font-medium text-app-text">{c.tip}</span>
                    </div>
                    {c.detail && <p className="text-app-caption text-app-text-muted mt-0.5 ml-1">{c.detail}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function AnalysisModal({ label, summary, onClose }: { label: string; summary: AnalysisSummary; onClose: () => void }) {
  const a = (summary.raw ?? {}) as AnalysisData;
  const [tab, setTab] = useState("analysis");
  const setup = a.setup ?? [];
  return (
    <AnalysisModalShell
      subtitle={label}
      onClose={onClose}
      tabs={[{ key: "analysis", label: m.label_ai_analysis() }, ...(setup.length ? [{ key: "setup", label: m.aidisplay_setup(), badge: setup.length }] : [])]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === "setup" ? <SetupList setup={setup} lookupSegs={null} /> : <AnalysisDisplay analysis={a} />}
    </AnalysisModalShell>
  );
}
