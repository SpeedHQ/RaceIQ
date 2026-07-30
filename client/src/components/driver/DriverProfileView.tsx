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

function formatConfidence(value: string): string {
  return value === "very-low" ? "very-low confidence" : `${value} confidence`;
}

function PatternList({ weaknesses, unquantifiedWeaknesses }: { weaknesses: RankedWeakness[]; unquantifiedWeaknesses: RankedWeakness[] }) {
  const patterns = [...weaknesses, ...unquantifiedWeaknesses].slice(0, 3);
  return (
    <article className="rounded-xl border border-app-border bg-app-surface p-4">
      <b className="text-sm text-app-text">Recurring patterns</b>
      {patterns.length === 0 ? (
        <p className="mt-2 text-xs text-app-text-muted">No recurring patterns measured yet.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm text-app-text">
          {patterns.map((weakness) => (
            <li key={weakness.id}>
              {weakness.label} <span className="text-xs text-app-text-muted">· {(weakness.perLapFrequency * 100).toFixed(0)}% of recent laps</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AiStatus({ state, reason }: { state?: DriverProfileState; reason?: string }) {
  const label = state === "queued" ? "Queued" : state === "running" ? "Running" : state === "failed" ? "Failed" : state === "not-configured" ? "Provider not configured" : "Current";
  return (
    <article className="rounded-xl border border-app-border bg-app-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <b className="text-sm text-app-text">AI summary</b>
        <span className="rounded-full bg-app-surface-alt px-2 py-1 text-[10px] text-app-text-muted">{label}</span>
      </div>
      <p className="mt-3 text-xs text-app-text-muted">{reason ?? "Automatically refreshes after enough new laps; manual refresh remains available."}</p>
    </article>
  );
}

export function DriverProfileView({ fingerprint: fp, plan = null, runReason, runState, onRefresh, runPending = false }: DriverProfileViewProps) {
  return (
    <div className="min-w-0">
      <DriverTrendOverview trend={fp.trend} summary={plan} runState={runState} onRefresh={onRefresh} runPending={runPending} />
      <section className="mt-6" aria-labelledby="driver-detail-heading">
        <h2 id="driver-detail-heading" className="text-base font-semibold text-app-text">
          Full profile detail
        </h2>
        <p className="mt-1 text-xs text-app-text-muted">Existing measured detail remains visible; removed: “Faults you don’t have” and “Next session”</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <article className="rounded-xl border border-app-border bg-app-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <b className="text-sm text-app-text">Driving style</b>
              <span className="text-xs text-app-text-muted">
                latest {fp.trend.recent.total} · {formatConfidence(fp.confidence)}
              </span>
            </div>
            <p className="mt-1 text-xs text-app-text-muted">Measured from telemetry, including usable telemetry from dirty laps.</p>
            {fp.style ? (
              <StyleGauges style={fp.style} recentNormalizedCount={fp.trend.recent.normalized} />
            ) : (
              <p className="mt-4 text-xs text-app-text-muted">Not enough laps to characterise a style yet. Drive a few more and rebuild.</p>
            )}
          </article>
          <PatternList weaknesses={fp.weaknesses} unquantifiedWeaknesses={fp.unquantifiedWeaknesses} />
          <AiStatus state={runState} reason={runReason} />
          <article className="rounded-xl border border-app-border bg-app-surface p-4">
            <b className="text-sm text-app-text">Data caveats</b>
            {fp.notes.length === 0 ? (
              <p className="mt-3 text-xs text-app-text-muted">No data caveats.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-xs text-app-text-muted">
                {fp.notes.slice(0, 4).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
