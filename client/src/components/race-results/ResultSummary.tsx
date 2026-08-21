import type { RaceResult, RaceResultAggregate, RaceResultOutcomeStatus, RaceResultStatus } from "@shared/racing/results/types";
import { isEligibilityUsable } from "@shared/racing/quality/policies";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GameId } from "../../../../shared/games/ids";
import { queryKeys } from "../../hooks/query-keys";
import { client } from "../../lib/rpc";
import { m } from "../../paraglide/messages";
import { localizedEligibilityDecisionText } from "../LapQualityBadge";

const classificationLabels: Record<RaceResultStatus, string> = {
  finished: "Finished",
  dnf: "DNF",
  disqualified: "Disqualified",
  "not-classified": "Not classified",
  retired: "Retired",
  qualifying: "Qualifying",
  unknown: "Classification unavailable",
};

const outcomeStatusPresentation: Record<RaceResultOutcomeStatus, { label: string; description: string; className: string }> = {
  confirmed: {
    label: "Confirmed",
    description: "Validated simulator or session result",
    className: "border-status-success/30 bg-status-success/10 text-status-success",
  },
  provisional: {
    label: "Provisional · derived",
    description: "Deterministic fallback or unresolved source conflict",
    className: "border-status-warning/30 bg-status-warning/10 text-status-warning",
  },
  unavailable: {
    label: "Unavailable",
    description: "No authoritative outcome was recorded",
    className: "border-status-unavailable/30 bg-status-unavailable/10 text-status-unavailable",
  },
};

export function ResultStatusBadge({ status }: { status: RaceResultStatus }) {
  return <span className="rounded-full border border-app-border px-2 py-0.5 text-app-caption text-app-text-muted">{classificationLabels[status]}</span>;
}

export function ResultAuthorityBadge({ status }: { status: RaceResultOutcomeStatus }) {
  const presentation = outcomeStatusPresentation[status];
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-app-caption font-medium", presentation.className)} title={presentation.description}>
      {presentation.label}
    </span>
  );
}

export function ResultAggregateGrid({ aggregate }: { aggregate: RaceResultAggregate }) {
  const timingUsable = aggregate.lapQuality.officialTiming.statuses.eligible + aggregate.lapQuality.officialTiming.statuses.eligible_with_warning;
  const paceUsable = aggregate.lapQuality.normalPace.statuses.eligible + aggregate.lapQuality.normalPace.statuses.eligible_with_warning;
  const rows: Array<[string, number | string]> = [
    ["Recorded results", aggregate.sessions],
    ["Confirmed", aggregate.confirmed],
    ["Provisional", aggregate.provisional],
    ["Unavailable", aggregate.unavailable],
    ["Recorded finishes", aggregate.finished],
    ["Recorded DNF / retired", aggregate.dnf + aggregate.retired],
    ["Recorded disqualifications", aggregate.disqualified],
    ["Recorded not classified", aggregate.notClassified],
    ["Recorded qualifying", aggregate.qualifying],
    ["Recorded podiums", aggregate.podiums],
    ["Recorded fastest laps", aggregate.fastestLaps],
    ["Recorded pit stops", aggregate.pitStops],
    ["Known pit time", aggregate.pitDurationSeconds == null ? "Not recorded" : `${aggregate.pitDurationSeconds.toFixed(1)}s`],
    [m.race_quality_timing_usable_laps(), aggregate.lapQuality.total === 0 ? m.race_quality_not_recorded() : `${timingUsable}/${aggregate.lapQuality.total}`],
    [m.race_quality_normal_pace_laps(), aggregate.lapQuality.total === 0 ? m.race_quality_not_recorded() : `${paceUsable}/${aggregate.lapQuality.total}`],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0 rounded-lg bg-app-surface-alt/50 px-3 py-2">
          <dt className="text-app-caption text-app-text-muted">{label}</dt>
          <dd className="mt-0.5 truncate font-mono font-medium tabular-nums text-app-text" title={String(value)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SummaryShell({ children, className, title, busy }: { children: ReactNode; className?: string; title: string; busy?: boolean }) {
  return (
    <section aria-busy={busy || undefined} aria-label={title} className={cn("rounded-xl border border-app-border bg-app-surface p-4 text-app-text", className)}>
      <h2 className="text-sm font-semibold text-app-text">{title}</h2>
      {children}
    </section>
  );
}

function RecentResult({ result }: { result: RaceResult }) {
  const { fieldStatus, conflicts } = result.evidence;
  const position =
    result.finishingPosition != null && fieldStatus.finishingPosition !== "unavailable"
      ? { label: "Finished", value: result.finishingPosition }
      : result.qualifyingPosition != null && fieldStatus.qualifyingPosition !== "unavailable"
        ? { label: "Qualified", value: result.qualifyingPosition }
        : null;
  const timingUsable = result.lapQuality.filter(({ officialTiming }) => isEligibilityUsable(officialTiming)).length;
  const paceUsable = result.lapQuality.filter(({ normalPace }) => isEligibilityUsable(normalPace)).length;
  const timingLimitation = result.lapQuality.find(({ officialTiming }) => !isEligibilityUsable(officialTiming))?.officialTiming;
  const paceLimitation = result.lapQuality.find(({ normalPace }) => !isEligibilityUsable(normalPace))?.normalPace;
  return (
    <li className="border-t border-app-border py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium text-app-text">Session {result.sessionId}</div>
          <div className="text-app-caption text-app-text-muted">{fieldStatus.sessionType === "unavailable" || result.sessionType === "unknown" ? "Session type unavailable" : result.sessionType}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <ResultAuthorityBadge status={result.outcomeStatus} />
          {fieldStatus.classification !== "unavailable" && <ResultStatusBadge status={result.classification} />}
          {position && (
            <span className="text-app-caption font-medium text-app-text">
              {position.label} P{position.value}
            </span>
          )}
          {result.isPodium === true && fieldStatus.isPodium !== "unavailable" && <span className="text-app-caption text-app-text-muted">Podium</span>}
          {result.isFastestLap === true && fieldStatus.isFastestLap !== "unavailable" && <span className="text-app-caption text-app-text-muted">Fastest lap</span>}
        </div>
      </div>
      {result.outcomeStatus === "unavailable" && <p className="mt-1 text-xs text-app-text-muted">No authoritative outcome was recorded for this session.</p>}
      {result.lapQuality.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-app-text-muted">
          <span>
            {m.race_quality_timing_summary({ usable: timingUsable, total: result.lapQuality.length })}
            {timingLimitation ? ` · ${localizedEligibilityDecisionText(timingLimitation)}` : ""}
          </span>
          <span>
            {m.race_quality_normal_pace_summary({ usable: paceUsable, total: result.lapQuality.length })}
            {paceLimitation ? ` · ${localizedEligibilityDecisionText(paceLimitation)}` : ""}
          </span>
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="mt-2 rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning" role="note">
          <div className="font-medium">Conflicting result evidence</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {conflicts.map((conflict) => (
              <li key={conflict}>{conflict}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export interface RaceResultSummaryProps {
  className?: string;
  gameId: GameId | null;
  title?: string;
  trackOrdinal?: number;
}

export function RaceResultSummary({ className, gameId, title = "Race results", trackOrdinal }: RaceResultSummaryProps) {
  const query = useQuery({
    queryKey: queryKeys.raceResultSummary(gameId, trackOrdinal),
    enabled: gameId != null,
    queryFn: async () => {
      if (!gameId) return null;
      const response = await client.api["race-results"].summary.$get({
        query: { gameId, trackOrdinal: trackOrdinal == null ? undefined : String(trackOrdinal) },
      });
      if (!response.ok) throw new Error(response.statusText);
      return response.json() as Promise<RaceResultAggregate>;
    },
  });
  const recentQuery = useQuery({
    queryKey: queryKeys.raceResultRecent(gameId),
    enabled: gameId != null && trackOrdinal == null,
    queryFn: async () => {
      if (!gameId) return [] as RaceResult[];
      const response = await client.api["race-results"].recent.$get({ query: { gameId, limit: "5" } });
      if (!response.ok) throw new Error(response.statusText);
      return response.json() as Promise<RaceResult[]>;
    },
  });

  if (!gameId) return null;
  if (query.isLoading) {
    return (
      <SummaryShell busy className={className} title={title}>
        <p className="mt-2 text-sm text-app-text-muted" role="status">
          Loading recorded results…
        </p>
      </SummaryShell>
    );
  }
  if (query.isError || !query.data) {
    return (
      <SummaryShell className={className} title={title}>
        <p className="mt-2 text-sm text-status-danger" role="alert">
          Recorded results are unavailable right now.
        </p>
      </SummaryShell>
    );
  }
  if (query.data.sessions === 0) {
    return (
      <SummaryShell className={className} title={title}>
        <p className="mt-2 text-sm text-app-text-muted">No recorded race or qualifying outcomes yet.</p>
      </SummaryShell>
    );
  }

  return (
    <SummaryShell className={className} title={title}>
      <p className="mt-1 mb-3 text-xs text-app-text-muted">Confirmed outcomes use validated session data. Provisional outcomes use deterministic fallback and remain labeled.</p>
      <ResultAggregateGrid aggregate={query.data} />
      {trackOrdinal == null && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-app-text">Recent sessions</h3>
          {recentQuery.isLoading && (
            <p className="mt-2 text-xs text-app-text-muted" role="status">
              Loading recent session details…
            </p>
          )}
          {recentQuery.isError && (
            <p className="mt-2 text-xs text-status-danger" role="alert">
              Recent session details are unavailable.
            </p>
          )}
          {recentQuery.data && recentQuery.data.length === 0 && <p className="mt-2 text-xs text-app-text-muted">No recent session details are available.</p>}
          {recentQuery.data && recentQuery.data.length > 0 && (
            <ul className="mt-2">
              {recentQuery.data.map((result) => (
                <RecentResult key={result.id} result={result} />
              ))}
            </ul>
          )}
        </div>
      )}
    </SummaryShell>
  );
}
