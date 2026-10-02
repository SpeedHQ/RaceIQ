import { isPitCycleLap } from "@shared/racing/laps/pit-cycle";
import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useMemo, useState } from "react";
import { Table, TableBody as TBody, TableCell as TD, TableHead as TH, TableHeader as THead, TableRow as TRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Button } from "@/components/ui/button";
import type { ExperimentLapMetric } from "@/hooks/experiments";
import { useSetLapExcluded } from "@/hooks/laps";
import { formatLapTime } from "@/lib/format";

const INVALID_REASON_LABELS: Record<string, string> = {
  "too few telemetry packets": "No telemetry",
  "telemetry distance too short": "Short distance",
  "telemetry lap time mismatch": "Time mismatch",
  "starting lap": "Starting lap",
  "start/end positions too far apart": "Position jump",
  rewind: "Rewind",
  incomplete: "Incomplete",
};
function lapStatusLabel(l: LapMeta): string | null {
  if (l.isValid) return null;
  const reason = l.invalidReason ?? null;
  if (!reason) return "Invalid";
  if (isPitCycleLap(l)) return reason[0].toUpperCase() + reason.slice(1);
  return INVALID_REASON_LABELS[reason] ?? (reason.startsWith("lap skip") ? "Lap skip" : reason[0].toUpperCase() + reason.slice(1));
}
type SortKey = "lap" | "time" | "fuel" | "wear";
type StatusFilter = "all" | "clean" | "eval" | "outside" | "invalid" | "excluded";
const STATUS_FILTERS: StatusFilter[] = ["all", "clean", "eval", "outside", "invalid", "excluded"];
const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "Status",
  clean: "Status: Clean",
  eval: "Status: Eval",
  outside: `Status: Outside top ${REVIEW_LAP_CAP}`,
  invalid: "Status: Invalid",
  excluded: "Status: Excluded",
};
function matchesStatusFilter(filter: StatusFilter, l: LapMeta, reason: string | undefined): boolean {
  if (filter === "all") return true;
  if (l.experimentExcluded === true) return filter === "excluded";
  if (lapStatusLabel(l) != null) return filter === "invalid";
  if (filter === "eval") return reason === "chosen";
  if (filter === "outside") return reason === "slower-than-cap";
  return filter === "clean";
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
    const rows = laps.filter((l) => matchesStatusFilter(statusFilter, l, selection.reasonById.get(l.id)));
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
    <Table className="w-full min-w-0 text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40 text-app-compact [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5">
      <THead>
        <TRow className="border-b border-app-border">
        <SortableTableHead className="px-2 py-1.5 text-left" direction={sort.key === "lap" ? (sort.dir === 1 ? "ascending" : "descending") : undefined} onSort={() => toggleSort("lap")} title="Sort by lap">
          Lap
        </SortableTableHead>
        <TH className="px-2 py-1.5 text-left">
          <button type="button" className="inline-flex items-center gap-1 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={cycleStatusFilter} title="Filter by status">
            <span className={statusFilter !== "all" ? "text-app-accent" : undefined}>{STATUS_FILTER_LABELS[statusFilter]}</span>
          </button>
        </TH>
        {(
          [
            ["time", "Time"],
            ["fuel", "Fuel used"],
            ["wear", "Tyre wear"],
          ] as [SortKey, string][]
        ).map(([key, label]) => (
          <SortableTableHead
            key={key}
            className="px-2 py-1.5 text-right"
            direction={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
            onSort={() => toggleSort(key)}
            title={`Sort by ${label.toLowerCase()}`}
          >
            {label}
          </SortableTableHead>
        ))}
        </TRow>
      </THead>
      <TBody>
        {sortedLaps.map((l) => {
          const isFastest = bestT != null && l.isValid && l.lapTime === bestT;
          const metric = metricsById.get(l.id);
          const excluded = l.experimentExcluded === true;
          const status = excluded ? "Excluded by user" : lapStatusLabel(l);
          const isPitStatus = !excluded && status != null && status.toLowerCase() !== "invalid";
          const reason = selection.reasonById.get(l.id);
          const strike = excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "";
          return (
            <TRow key={l.id} className="group/row relative transition-colors">
              <TD className={`px-2 py-1.5 text-right font-mono tabular-nums ${l.isValid ? "text-app-text-muted" : "text-status-danger"}`} title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}>
                <span className={strike}>
                  {showSession && (
                    <span className="text-app-text-dim mr-1" title={`Imported from session ${l.sessionId}`}>
                      S{l.sessionId}·
                    </span>
                  )}
                  {l.lapNumber}
                </span>
              </TD>
              <TD className="px-2 py-1.5 text-app-text-secondary">
                <div className="flex items-center gap-1">
                  <span className="w-[130px] shrink-0 flex items-center gap-2">
                    {status && (
                      <span
                        className={`text-app-caption uppercase tracking-wider truncate ${excluded ? "text-app-text-dim" : isPitStatus ? "text-status-warning" : "text-status-danger"}`}
                        title={excluded ? "Excluded from the tuning aggregate by you" : (l.invalidReason ?? undefined)}
                      >
                        {status}
                      </span>
                    )}
                    {reason === "chosen" && (
                      <span
                        className="text-app-caption uppercase tracking-wider text-status-success"
                        title={`Used for evaluation — one of the fastest ${REVIEW_LAP_CAP} clean laps this analysis reads`}
                      >
                        Eval
                      </span>
                    )}
                    {reason === "slower-than-cap" && (
                      <span className="text-app-caption uppercase tracking-wider text-app-text-dim" title={`Clean lap, but outside the fastest ${REVIEW_LAP_CAP} — not used for evaluation`}>
                        Outside top {REVIEW_LAP_CAP}
                      </span>
                    )}
                  </span>
                  {l.isValid && (
                    <Button
                      type="button"
                      onClick={() => setExcluded.mutate({ lapId: l.id, excluded: !excluded, experimentId })}
                      disabled={setExcluded.isPending}
                      title={excluded ? "Include this lap in the tuning aggregate again" : "Exclude this lap from the tuning aggregate (blunder, off-track, spin)"}
                      className={`text-app-caption uppercase tracking-wider px-1.5 py-0.5 rounded border disabled:opacity-50 disabled:pointer-events-none ${excluded ? "border-app-border text-app-text-dim opacity-60" : "border-app-border text-app-text hover:bg-app-surface-hover/30"}`}
                    >
                      {excluded ? "Excluded" : "Exclude"}
                    </Button>
                  )}
                </div>
              </TD>
              <TD className={`px-2 py-1.5 text-right font-mono tabular-nums ${isFastest ? "text-(--lap-pace-best)" : "text-app-text"}`}>
                <span className={strike}>{formatLapTime(l.lapTime)}</span>
              </TD>
              <TD className="px-2 py-1.5 text-right font-mono tabular-nums text-app-text">
                <span className={strike}>{metric?.fuelPerLap != null ? `${metric.fuelPerLap.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</span>
              </TD>
              <TD className="px-2 py-1.5 text-right font-mono tabular-nums text-app-text">
                <span className={strike}>{metric?.tyreWear != null ? `${metric.tyreWear.toFixed(0)}%` : <span className="text-app-text-dim">—</span>}</span>
              </TD>
            </TRow>
          );
        })}
      </TBody>
    </Table>
  );
}
