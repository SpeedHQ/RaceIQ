import type { EligibilityStatus } from "@shared/racing/quality/contracts";
import { isEligibilityUsable } from "@shared/racing/quality/policies";
import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useMemo, useState } from "react";
import { LapQualityBadge, localizedEligibilityDecisionPresentation } from "@/components/LapQualityBadge";
import { LapStatus } from "@/components/LapStatus";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import type { ExperimentLapMetric } from "@/hooks/experiments";
import { useSetLapExcluded } from "@/hooks/laps";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

type SortKey = "lap" | "time" | "fuel" | "wear";
type StatusFilter = "all" | EligibilityStatus | "eval" | "outside" | "excluded";
const STATUS_FILTERS: StatusFilter[] = ["all", "eligible", "eligible_with_warning", "ineligible", "unknown", "eval", "outside", "excluded"];
const STATUS_FILTER_LABELS: Record<StatusFilter, () => string> = {
  all: () => "Status",
  eligible: m.quality_status_eligible,
  eligible_with_warning: m.quality_status_eligible_with_warning,
  ineligible: m.quality_status_ineligible,
  unknown: m.quality_status_unknown,
  eval: () => "Status: Eval",
  outside: () => `Status: Outside top ${REVIEW_LAP_CAP}`,
  excluded: () => "Status: Excluded",
};
function matchesStatusFilter(filter: StatusFilter, lap: LapMeta, reason: string | undefined, policyStatus: EligibilityStatus): boolean {
  if (filter === "all") return true;
  if (filter === "excluded") return lap.experimentExcluded === true;
  if (lap.experimentExcluded === true) return false;
  if (filter === "eval") return reason === "chosen";
  if (filter === "outside") return reason === "slower-than-cap";
  return filter === policyStatus;
}
function sortValue(key: SortKey, l: LapMeta, metricsById: Map<number, ExperimentLapMetric>): number | null {
  switch (key) {
    case "lap":
      return l.sessionId * 1e6 + l.lapNumber;
    case "time":
      return l.lapTime ?? null;
    case "fuel":
      return metricsById.get(l.id)?.fuelPerLap ?? null;
    case "wear":
      return metricsById.get(l.id)?.tyreWear ?? null;
  }
}

export function LapBreakdown({ laps, bestT, metricsById, experimentId }: { laps: LapMeta[]; bestT: number | null; metricsById: Map<number, ExperimentLapMetric>; experimentId?: number | null }) {
  const setExcluded = useSetLapExcluded();
  const selection = useMemo(() => selectEvaluationLaps(laps), [laps]);
  const showSession = useMemo(() => new Set(laps.map((l) => l.sessionId)).size > 1, [laps]);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "lap", dir: 1 });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const sortedLaps = useMemo(() => {
    const rows = laps.filter((l) => {
      const decision = selection.rejectionDecisionById.get(l.id) ?? selection.setupDecision;
      return matchesStatusFilter(statusFilter, l, selection.reasonById.get(l.id), decision.status);
    });
    rows.sort((a, b) => {
      if (a.sessionId !== b.sessionId) return a.sessionId - b.sessionId;
      const av = sortValue(sort.key, a, metricsById);
      const bv = sortValue(sort.key, b, metricsById);
      if (av == null && bv == null) return a.lapNumber - b.lapNumber;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.lapNumber - b.lapNumber;
      return (av < bv ? -1 : 1) * sort.dir;
    });
    return rows;
  }, [laps, metricsById, sort, statusFilter, selection]);
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const cycleStatusFilter = () => setStatusFilter((s) => STATUS_FILTERS[(STATUS_FILTERS.indexOf(s) + 1) % STATUS_FILTERS.length]);
  if (laps.length === 0) return <div className="px-3 py-2 text-app-subtext text-app-text-dim">No laps recorded against this version yet.</div>;
  return (
    <Table density="compact" fit>
      <THead>
        <SortableTH direction={sort.key === "lap" ? (sort.dir === 1 ? "ascending" : "descending") : undefined} onSort={() => toggleSort("lap")} title="Sort by lap">
          Lap
        </SortableTH>
        <TH
          onClick={cycleStatusFilter}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            cycleStatusFilter();
          }}
          tabIndex={0}
          role="button"
          aria-label={`Filter by candidate quality status. Current filter: ${STATUS_FILTER_LABELS[statusFilter]()}`}
          title="Filter by status"
        >
          <span className={statusFilter !== "all" ? "text-app-accent" : undefined}>{STATUS_FILTER_LABELS[statusFilter]()}</span>
        </TH>
        {(
          [
            ["time", "Time"],
            ["fuel", "Fuel used"],
            ["wear", "Tyre wear"],
          ] as [SortKey, string][]
        ).map(([key, label]) => (
          <SortableTH
            key={key}
            align="end"
            direction={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
            onSort={() => toggleSort(key)}
            title={`Sort by ${label.toLowerCase()}`}
          >
            {label}
          </SortableTH>
        ))}
      </THead>
      <TBody>
        {sortedLaps.map((l) => {
          const isFastest = bestT != null && selection.chosenIds.has(l.id) && l.lapTime === bestT;
          const metric = metricsById.get(l.id);
          const excluded = l.experimentExcluded === true;
          const reason = selection.reasonById.get(l.id);
          const qualityDecision = selection.rejectionDecisionById.get(l.id) ?? selection.setupDecision;
          const qualityUsable = isEligibilityUsable(qualityDecision);
          const qualityPresentation = localizedEligibilityDecisionPresentation(qualityDecision);
          const qualityReasonId = `lap-${l.id}-quality-reason`;
          const strike = excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "";
          return (
            <TRow key={l.id}>
              <TD numeric tone="muted">
                <span className={strike}>
                  {showSession && (
                    <span className="text-app-text-dim mr-1" title={`Imported from session ${l.sessionId}`}>
                      S{l.sessionId}·
                    </span>
                  )}
                  {l.lapNumber}
                </span>
              </TD>
              <TD>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <LapQualityBadge lap={l} policyId={qualityDecision.policyId} decisionOverride={qualityDecision} />
                    <div className="flex min-w-0 max-w-48 flex-col gap-1">
                      <span className="text-app-caption font-medium text-app-text" data-eligibility-policy={qualityDecision.policyId} data-eligibility-status={qualityDecision.status}>
                        {qualityPresentation.status}
                      </span>
                      {qualityPresentation.firstReason && (
                        <span id={qualityReasonId} className="truncate text-app-micro text-app-text-muted" title={qualityPresentation.firstReason}>
                          {qualityPresentation.firstReason}
                        </span>
                      )}
                      <span className="flex min-w-0 items-center gap-2">
                        {excluded ? (
                          <span className="truncate text-app-caption uppercase tracking-wider text-app-text-dim" title="Excluded from tuning aggregate by you">
                            Excluded by user
                          </span>
                        ) : (
                          <LapStatus lap={l} visibility="issues" />
                        )}
                        {reason === "chosen" && (
                          <span
                            className="text-app-caption uppercase tracking-wider text-status-success"
                            title={`Used for evaluation — one of the fastest ${REVIEW_LAP_CAP} suitable laps this analysis reads`}
                          >
                            Eval
                          </span>
                        )}
                        {reason === "slower-than-cap" && (
                          <span className="text-app-caption uppercase tracking-wider text-app-text-dim" title={`Suitable lap, but outside the fastest ${REVIEW_LAP_CAP} — not used for evaluation`}>
                            Outside top {REVIEW_LAP_CAP}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="app-outline"
                    size="app-sm"
                    onClick={() => setExcluded.mutate({ lapId: l.id, excluded: !excluded, experimentId })}
                    disabled={setExcluded.isPending || !qualityUsable}
                    aria-describedby={qualityPresentation.firstReason ? qualityReasonId : undefined}
                    aria-label={`${excluded ? "Include" : "Exclude"} lap ${l.lapNumber}${qualityUsable ? "" : `. ${qualityPresentation.text}`}`}
                    title={!qualityUsable ? qualityPresentation.text : excluded ? "Include this lap in tuning aggregate again" : "Exclude this lap from tuning aggregate (blunder, off-track, spin)"}
                  >
                    {excluded ? "Include" : "Exclude"}
                  </Button>
                </div>
              </TD>
              <TD align="end" numeric tone={isFastest ? "best" : "primary"}>
                <span className={strike}>{formatLapTime(l.lapTime)}</span>
              </TD>
              <TD align="end" numeric tone="primary">
                <span className={strike}>{metric?.fuelPerLap != null ? `${metric.fuelPerLap.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</span>
              </TD>
              <TD align="end" numeric tone="primary">
                <span className={strike}>{metric?.tyreWear != null ? `${metric.tyreWear.toFixed(0)}%` : <span className="text-app-text-dim">—</span>}</span>
              </TD>
            </TRow>
          );
        })}
      </TBody>
    </Table>
  );
}
