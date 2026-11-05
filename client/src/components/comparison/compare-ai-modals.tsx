import { Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { parseCornerActions } from "@raceiq/lap-replay/contracts";
import { useCornerFocusController } from "@raceiq/lap-replay/ui";
import { CornerActionText } from "@/components/ai/CornerActionText";
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
  const actions = useMemo(() => parseCornerActions(analysis.actions), [analysis.actions]);
  const cornerFocus = useCornerFocusController();
  const inline = (text: string, path: string) => {
    const matching = actions.filter((action) => action.path === path);
    return matching.length > 0 ? <CornerActionText text={text} actions={matching} /> : text;
  };
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
          {analysis.verdict && <p className="text-app-label text-app-text leading-relaxed">{inline(analysis.verdict, "verdict")}</p>}

          {analysis.segments?.length > 0 && (
            <div className="space-y-2">
              {analysis.segments.map((seg, index) => {
                // Resolve the AI-named segment to a track position so clicking
                // the card moves the chart/track cursor to that segment.
                const match = trackSegments?.find((s) => {
                  const sn = s.name.toLowerCase();
                  const gn = seg.name.toLowerCase();
                  return sn === gn || sn.includes(gn) || gn.includes(sn);
                });
                const clickable = !!(match && (cornerFocus.enabled || onJumpToFrac));
                const activate = () => {
                  if (!match) return;
                  if (cornerFocus.enabled) {
                    cornerFocus.focus({
                      id: `inputs:${match.name}`,
                      cornerKey: match.name,
                      label: match.name,
                      target: "linked",
                      span: { start: 0, end: 1 },
                    }, { loop: false });
                    return;
                  }
                  onJumpToFrac?.((match.startFrac + match.endFrac) / 2);
                };
                return (
                  <div
                    key={`${seg.name}-${seg.type ?? ""}-${seg.deltaSeconds ?? ""}`}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    data-corner-card={clickable ? match?.name : undefined}
                    onClick={clickable ? activate : undefined}
                    onKeyDown={clickable ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      activate();
                    } : undefined}
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
                        <span className="text-(--ch-throttle)/70 font-medium">{m.compare_throttle()}</span> {inline(seg.throttle, `segments[${index}].throttle`)}
                      </div>
                      <div>
                        <span className="text-(--ch-brake)/70 font-medium">{m.compare_brake()}</span> {inline(seg.brake, `segments[${index}].brake`)}
                      </div>
                      <div>
                        <span className="text-(--ch-steer)/70 font-medium">{m.compare_steering()}</span> {inline(seg.steering, `segments[${index}].steering`)}
                      </div>
                    </div>
                    {seg.action && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded bg-ai-accent/10 border border-ai-accent/30 px-2 py-1.5">
                        <Sparkles className="size-3 text-ai-accent shrink-0 mt-0.5" />
                        <span className="text-app-compact text-ai-accent leading-snug">{inline(seg.action, `segments[${index}].action`)}</span>
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
                {analysis.coaching.map((c, index) => (
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
                    {c.detail && <p className="text-app-caption text-app-text-muted mt-0.5 ml-1">{inline(c.detail, `coaching[${index}].detail`)}</p>}
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
export function AnalysisModal({ label, summary, trackSegments, focusTarget, lapId, onClose }: { label: string; summary: AnalysisSummary; trackSegments?: { name: string; startFrac: number; endFrac: number }[]; focusTarget?: "A" | "B"; lapId?: number | null; onClose: () => void }) {
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
      {tab === "setup" ? <SetupList setup={setup} lookupSegs={null} /> : <AnalysisDisplay analysis={a} segments={trackSegments?.map((segment) => ({ ...segment, type: "corner" }))} focusTarget={focusTarget} lapId={lapId} />}
    </AnalysisModalShell>
  );
}
