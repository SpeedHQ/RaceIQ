import * as m from "@/paraglide/messages";
import type { DriverProfileSummary } from "@raceiq/backend-core/ai/schemas";
import type { RankedWeakness } from "@raceiq/backend-core/driver-profile/detectors";
import type { DriverFingerprint } from "@raceiq/backend-core/driver-profile/fingerprint";
import type { DriverProfileRun, DriverProfileState } from "../../hooks/driver-profile";
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
  return value === "very-low" ? m.driver_very_low_confidence() : m.driver_confidence({ level: value });
}

function PatternList({ weaknesses, unquantifiedWeaknesses }: { weaknesses: RankedWeakness[]; unquantifiedWeaknesses: RankedWeakness[] }) {
  const patterns = [...weaknesses, ...unquantifiedWeaknesses].slice(0, 3);
  return (
    <article className="rounded-xl border border-app-border bg-app-surface p-4">
      <b className="text-sm text-app-text">{m.driver_recurring_patterns()}</b>
      {patterns.length === 0 ? (
        <p className="mt-2 text-xs text-app-text-muted">{m.driver_no_recurring_patterns()}</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm text-app-text">
          {patterns.map((weakness) => (
            <li key={weakness.id}>
              {weakness.label} <span className="text-xs text-app-text-muted">· {m.driver_recent_lap_frequency({ percent: (weakness.perLapFrequency * 100).toFixed(0) })}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AiStatus({ state, reason }: { state?: DriverProfileState; reason?: string }) {
  const label = state === "queued" ? m.driver_status_queued() : state === "running" ? m.driver_status_running() : state === "failed" ? m.driver_status_failed() : state === "not-configured" ? m.driver_provider_not_configured() : m.driver_status_current();
  return (
    <article className="rounded-xl border border-app-border bg-app-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <b className="text-sm text-app-text">{m.driver_ai_summary()}</b>
        <span className="rounded-full bg-app-surface-alt px-2 py-1 text-app-caption text-app-text-muted">{label}</span>
      </div>
      <p className="mt-3 text-xs text-app-text-muted">{reason ?? m.driver_auto_refresh_explanation()}</p>
    </article>
  );
}

function RunHistory({ runs }: { runs: DriverProfileRun[] }) {
  return (
    <section className="rounded-xl border border-app-border bg-app-surface p-4" aria-labelledby="driver-run-history-heading">
      <div className="flex items-center justify-between gap-3">
        <b id="driver-run-history-heading" className="text-sm text-app-text">
          {m.driver_run_history()}
        </b>
        <span className="text-xs text-app-text-muted">
          {runs.length === 1 ? m.driver_run_count_one() : m.driver_run_count_other({ count: String(runs.length) })}
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="mt-3 text-xs text-app-text-muted">{m.driver_no_ai_runs()}</p>
      ) : (
        <ul className="mt-3 space-y-2 text-xs text-app-text-muted">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-3">
              <span>{run.createdAt}</span>
              <span className="rounded-full bg-app-surface-alt px-2 py-1">{run.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DriverProfileView({ fingerprint: fp, plan = null, runReason, runState, runHistory = [], onRefresh, runPending = false }: DriverProfileViewProps) {
  return (
    <div className="min-w-0">
      <DriverTrendOverview trend={fp.trend} summary={plan} runState={runState} onRefresh={onRefresh} runPending={runPending} />
      <section className="mt-6" aria-labelledby="driver-detail-heading">
        <h2 id="driver-detail-heading" className="text-base font-semibold text-app-text">
          {m.driver_full_profile_detail()}
        </h2>
        <p className="mt-1 text-xs text-app-text-muted">{m.driver_existing_measured_detail_note()}</p>
        <div className="mt-3 grid gap-3 @5xl/workspace:grid-cols-2">
          <article className="rounded-xl border border-app-border bg-app-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <b className="text-sm text-app-text">{m.driver_driving_style()}</b>
              <span className="text-xs text-app-text-muted">
                {m.driver_latest_count({ count: String(fp.trend.recent.total) })} · {formatConfidence(fp.confidence)}
              </span>
            </div>
            <p className="mt-1 text-xs text-app-text-muted">{m.driver_telemetry_measurement_note()}</p>
            {fp.style ? (
              <StyleGauges style={fp.style} recentNormalizedCount={fp.trend.recent.normalized} />
            ) : (
              <p className="mt-4 text-xs text-app-text-muted">{m.driver_more_laps_for_style()}</p>
            )}
          </article>
          <PatternList weaknesses={fp.weaknesses} unquantifiedWeaknesses={fp.unquantifiedWeaknesses} />
          <AiStatus state={runState} reason={runReason} />
          <article className="rounded-xl border border-app-border bg-app-surface p-4">
            <b className="text-sm text-app-text">{m.driver_data_caveats()}</b>
            {fp.notes.length === 0 ? (
              <p className="mt-3 text-xs text-app-text-muted">{m.driver_no_data_caveats()}</p>
            ) : (
              <ul className="mt-3 space-y-2 text-xs text-app-text-muted">
                {fp.notes.slice(0, 4).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </article>
          <RunHistory runs={runHistory} />
        </div>
      </section>
    </div>
  );
}
