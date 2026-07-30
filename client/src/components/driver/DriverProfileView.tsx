import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DriverFingerprint, RankedWeakness } from "../../../../server/ai/driver-profile-aggregate";
import type { DriverProfileSummary } from "../../../../server/ai/schemas";
import type { DriverProfileRun, DriverProfileState } from "../../hooks/queries";
import { DriverTrendOverview } from "./DriverTrendOverview";
import { StyleGauges } from "./StyleGauges";

export interface DriverProfileViewProps {
  fingerprint: DriverFingerprint;
  plan?: DriverProfileSummary | null;
  runReason?: string;
  runState?: DriverProfileState;
  latestRun?: DriverProfileRun | null;
  runHistory?: DriverProfileRun[];
  onRefresh?: () => void;
  runPending?: boolean;
}

const RUN_STATE_LABELS: Record<DriverProfileState | "idle", string> = {
  idle: "Not run",
  disabled: "Background disabled",
  "not-configured": "Provider not configured",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

function formatRunDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function WeaknessList({ title, description, weaknesses }: { title: string; description: string; weaknesses: RankedWeakness[] }) {
  if (weaknesses.length === 0) return null;
  return (
    <section className="min-w-0 rounded-lg bg-app-surface p-4 ring-1 ring-app-border">
      <h2 className="text-sm font-semibold text-app-text">{title}</h2>
      <p className="mt-1 text-xs text-app-text-muted">{description}</p>
      <ul className="mt-3 space-y-2">
        {weaknesses.slice(0, 6).map((weakness) => (
          <li key={weakness.id} className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-app-text">{weakness.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-app-text-muted">{(weakness.perLapFrequency * 100).toFixed(0)}% of laps · peak {weakness.peakSeverity}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunStatus({ state, latestRun, runHistory = [], reason }: { state?: DriverProfileState; latestRun?: DriverProfileRun | null; runHistory?: DriverProfileRun[]; reason?: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const effectiveState = state ?? "idle";
  const message =
    effectiveState === "disabled"
      ? "Background summaries are disabled; measured trend remains available."
      : effectiveState === "not-configured"
        ? reason ?? "Choose an AI provider in settings to generate a summary."
        : effectiveState === "queued"
          ? "Summary run is queued."
          : effectiveState === "running"
            ? "Summary run is in progress."
            : effectiveState === "failed"
              ? "Latest summary failed; measured trend remains available."
              : effectiveState === "succeeded"
                ? "Latest summary succeeded."
                : "No summary run yet.";

  return (
    <section className={`rounded-lg p-4 ring-1 ${effectiveState === "failed" ? "bg-dynamics-red/10 ring-dynamics-red/20" : "bg-app-surface ring-app-border"}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-app-text">AI run status</h2>
          <p className="mt-1 text-sm text-app-text-muted">{message}</p>
        </div>
        <span className="rounded-full bg-app-surface-alt px-2 py-1 text-xs font-medium text-app-text">{RUN_STATE_LABELS[effectiveState]}</span>
      </div>
      {(reason || latestRun?.error) && <p className="mt-2 text-xs text-dynamics-red" role={effectiveState === "failed" ? "alert" : undefined}>{latestRun?.error ?? reason}</p>}
      {latestRun && (
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-app-text-muted sm:grid-cols-2">
          <div><dt className="inline font-medium text-app-text">Created: </dt><dd className="inline">{formatRunDate(latestRun.createdAt) ?? "Unknown"}</dd></div>
          {latestRun.completedAt && <div><dt className="inline font-medium text-app-text">Completed: </dt><dd className="inline">{formatRunDate(latestRun.completedAt)}</dd></div>}
          <div><dt className="inline font-medium text-app-text">Model: </dt><dd className="inline">{latestRun.model || "Unknown"}</dd></div>
        </dl>
      )}
      {runHistory.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="mt-4 border-t border-app-border pt-3">
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left text-xs font-medium text-app-text-muted"><span>Run history ({runHistory.length})</span><ChevronDown className={`size-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} /></CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-2 space-y-2">
              {runHistory.map((run) => <li key={run.id} className="rounded-md bg-app-surface-alt/50 p-2 text-xs text-app-text-muted"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium text-app-text">{RUN_STATE_LABELS[run.status]}</span><span>{formatRunDate(run.createdAt) ?? "Unknown"}</span></div>{run.error && <p className="mt-1 text-dynamics-red">{run.error}</p>}</li>)}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

export function DriverProfileView({ fingerprint: fp, plan = null, runReason, runState, latestRun, runHistory, onRefresh, runPending = false }: DriverProfileViewProps) {
  return (
    <div className="min-w-0 space-y-5">
      <DriverTrendOverview trend={fp.trend} summary={plan} runState={runState} latestRun={latestRun} onRefresh={onRefresh} runPending={runPending} />

      <section className="min-w-0 rounded-lg bg-app-surface p-4 ring-1 ring-app-border">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-app-text">Driving style</h2>
          <span className="text-xs text-app-text-muted">{fp.laps.analyzed} lap{fp.laps.analyzed === 1 ? "" : "s"} · {fp.confidence} confidence</span>
        </div>
        <p className="mb-2 text-xs text-app-text-muted">Measured from telemetry; independent of AI summaries.</p>
        {fp.style ? <StyleGauges style={fp.style} recentNormalizedCount={fp.trend.recent.normalized} /> : <p className="py-4 text-sm text-app-text-muted">Not enough laps to characterise a style yet. Drive a few more and rebuild.</p>}
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <WeaknessList title="Recurring weaknesses" description="Quantified patterns ranked by measured impact." weaknesses={fp.weaknesses} />
        <WeaknessList title="Recurring patterns, cost not measured" description="Frequent patterns without a defensible time estimate." weaknesses={fp.unquantifiedWeaknesses} />
      </div>

      {fp.notes.length > 0 && <section className="rounded-lg bg-app-surface p-4 ring-1 ring-app-border"><h2 className="text-sm font-semibold text-app-text">Data caveats</h2><ul className="mt-2 space-y-1 text-xs text-app-text-muted">{fp.notes.map((note) => <li key={note}>· {note}</li>)}</ul></section>}
      <RunStatus state={runState} latestRun={latestRun} runHistory={runHistory} reason={runReason} />
    </div>
  );
}
