import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/review-laps";
import { parseTestChanges, summarizeTestChange } from "@shared/test-changes";
import type { LapMeta } from "@shared/types";
import { useMemo, useState } from "react";
import { type ExperimentLapMetric, useSetLapExcluded } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { Table } from "../ui/AppTable";
/**
 * Shared rendering pieces for a tuning test ("setup version"): the
 * applied-changes summary and the per-lap breakdown table. Both
 * ExperimentWorkspace (legacy flat list, kept for reference/tests) and
 * VersionGraph (the commit-graph view, Task 11) render the same version rows,
 * so this lives in its own module rather than being exported from either
 * component — VersionGraph importing from ExperimentWorkspace (or vice
 * versa) would create a circular import between the two.
 */

/** Parse the stored appliedChanges JSON into a typed list (empty on any issue).
 *  Re-exported from the shared normaliser so the client and the server prompt
 *  builders agree on how legacy (pre-v37, kind-less) rows are read. */
export const parseAppliedChanges = parseTestChanges;

/** One-line summary of a version's tweaks for collapsed tree rows, e.g.
 *  "+1 rear wing, softer rear ARB". Prefers the stored direction word when
 *  present, otherwise falls back to the signed numeric delta. Null when the
 *  version has no applied changes (base setup). */
export function summarizeAppliedChanges(json: string | null | undefined): string | null {
  const changes = parseTestChanges(json);
  if (changes.length === 0) return null;
  return changes.map(summarizeTestChange).join(", ");
}

/** What was tweaked for a setup version — rendered in the expanded version row
 *  and (live) in the chat after Generate. Base versions have no changes. */
export function AppliedChangesList({ json, comment }: { json: string | null; comment?: string | null }) {
  const changes = parseAppliedChanges(json);
  if (changes.length === 0 && !comment) return null;
  return (
    <div className="px-3 py-2 border-b border-app-border/40 space-y-1">
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Tweaks</div>
      {changes.length === 0 ? (
        <div className="text-app-compact text-app-text-dim">Base setup — no changes applied.</div>
      ) : (
        <ul className="space-y-0.5">
          {changes.map((c, i) =>
            c.kind === "drill" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: change rows are a frozen snapshot of one version's tweaks, never reordered; index disambiguates repeated components
              <li key={`drill-${c.title}-${i}`} className="text-app-compact text-app-text">
                <span className="font-mono text-status-warning">{c.title}</span>
                {c.corners.length > 0 && <span className="tabular-nums text-app-text-dim"> · {c.corners.join(", ")}</span>}
                {c.instruction && <div className="text-app-text-dim">{c.instruction}</div>}
              </li>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: same frozen snapshot; index disambiguates repeated components
              <li key={`${c.component}-${i}`} className="text-app-compact text-app-text">
                <span className="font-mono text-(--focus-setup)">{c.component}</span>{" "}
                <span className="tabular-nums text-app-text-dim">
                  {c.from} → {c.to}
                </span>
                {c.reason && <span className="text-app-text-dim"> · {c.reason}</span>}
              </li>
            ),
          )}
        </ul>
      )}
      {comment && <div className="text-app-compact text-app-text-dim italic">Driver: “{comment}”</div>}
    </div>
  );
}

/** invalidReason values that are pit-lane classification, not an error — shown
 *  as a neutral status badge instead of the red "invalid" styling. Set by
 *  classifyAccPitLap (server/acc-lap-rules.ts) for ACC/AC-Evo. */
const PIT_STATUS_REASONS = new Set(["outlap", "inlap", "pit lap"]);

/** Compact labels for the verbose reasons the detectors write (lap-quality.ts,
 *  lap-detection.ts) — the column is narrow, so the sentence form goes in the
 *  tooltip and the short form goes on screen. Unlisted reasons show as-is. */
const INVALID_REASON_LABELS: Record<string, string> = {
  "too few telemetry packets": "No telemetry",
  "telemetry distance too short": "Short distance",
  "telemetry lap time mismatch": "Time mismatch",
  "starting lap": "Starting lap",
  "start/end positions too far apart": "Position jump",
  rewind: "Rewind",
  incomplete: "Incomplete",
};

/** Short label for the Status column. Pit-lane laps get their classification
 *  ("Outlap"/"Inlap"/"Pit lap"); other invalid laps show why they're invalid
 *  (full reason still in the title); valid laps show nothing. */
function lapStatusLabel(l: LapMeta): string | null {
  if (l.isValid) return null;
  const reason = l.invalidReason ?? null;
  if (!reason) return "Invalid";
  if (PIT_STATUS_REASONS.has(reason)) return reason[0].toUpperCase() + reason.slice(1);
  const mapped = INVALID_REASON_LABELS[reason];
  if (mapped) return mapped;
  // Detectors also emit parameterised reasons, e.g. "lap skip (3 → 5)".
  if (reason.startsWith("lap skip")) return "Lap skip";
  return reason[0].toUpperCase() + reason.slice(1);
}

type SortKey = "lap" | "time" | "fuel" | "wear";

/** Status buckets for the breakdown table. Status is a filter (not a sort):
 *  the header cycles through these in order, "all" showing every lap. */
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

/** Does a lap belong in the currently selected status bucket? The eval badges
 *  live in the Status column too, so they filter from the same header:
 *  "clean" is every non-pit/invalid/excluded lap, and eval/outside split that
 *  group by whether the analysis actually reads the lap. */
function matchesStatusFilter(filter: StatusFilter, l: LapMeta, reason: string | undefined): boolean {
  if (filter === "all") return true;
  if (l.experimentExcluded === true) return filter === "excluded";
  // Pit laps (out/in/pit) are just one flavour of invalid — same bucket.
  if (lapStatusLabel(l) != null) return filter === "invalid";
  if (filter === "eval") return reason === "chosen";
  if (filter === "outside") return reason === "slower-than-cap";
  return filter === "clean";
}

/** Sort keys for the breakdown table; null means "no value" and always sinks. */
function sortValue(key: SortKey, l: LapMeta, metricsById: Map<number, ExperimentLapMetric>): number | string | null {
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

/** Per-lap breakdown for an expanded tune test. Fuel/lap and tyre wear are the
 *  real server-derived numbers (or "—" for legacy/unavailable laps, e.g. when the
 *  server omits a channel); the spun flag is omitted (parity Phase 2). */
export function LapBreakdown({
  laps,
  bestT,
  metricsById,
  experimentId,
}: {
  laps: LapMeta[];
  bestT: number | null;
  metricsById: Map<number, ExperimentLapMetric>;
  /** Session to invalidate after toggling exclusion (design §Phase 7). Laps
   *  outside an experiment (no exclude toggle context) can omit this. */
  experimentId?: number | null;
}) {
  const setExcluded = useSetLapExcluded();
  // Same selector the server's auto-exclude pass and /line-spread use, so the
  // badges here can't drift from the laps actually fed to the analysis.
  // Must run before the early return below (rules of hooks).
  const selection = useMemo(() => selectEvaluationLaps(laps), [laps]);
  // Only prefix when this table actually spans multiple source sessions —
  // single-session tables keep the plain lap number.
  const showSession = useMemo(() => new Set(laps.map((l) => l.sessionId)).size > 1, [laps]);
  // Sort is view-only — it never changes which laps feed the analysis.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "lap", dir: 1 });
  // Status is a filter, not a sort — the header cycles through the buckets.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const sortedLaps = useMemo(() => {
    const rows = laps.filter((l) => matchesStatusFilter(statusFilter, l, selection.reasonById.get(l.id)));
    rows.sort((a, b) => {
      // Session is always the primary key — laps from different sessions reuse
      // lap numbers, so rows stay grouped per session no matter what's sorted.
      if (a.sessionId !== b.sessionId) return a.sessionId - b.sessionId;
      const av = sortValue(sort.key, a, metricsById);
      const bv = sortValue(sort.key, b, metricsById);
      // Missing values (no metric / no time) always sink to the bottom.
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
  if (laps.length === 0) {
    return <div className="px-3 py-2 text-xs text-app-text-dim">No laps recorded against this version yet.</div>;
  }
  return (
    <Table fit tableClassName="w-full text-xs">
      <thead>
        <tr className="text-app-caption uppercase tracking-wider text-app-text-muted">
          <th className="px-3 py-1 font-medium text-left">
            <button type="button" onClick={() => toggleSort("lap")} className={`uppercase tracking-wider hover:text-app-text ${sort.key === "lap" ? "text-app-text" : ""}`} title="Sort by lap">
              Lap
              {sort.key === "lap" && <span className="ml-1">{sort.dir === 1 ? "▲" : "▼"}</span>}
            </button>
          </th>
          <th className="px-3 py-1 font-medium text-left">
            <button type="button" onClick={cycleStatusFilter} className={`uppercase tracking-wider hover:text-app-text ${statusFilter !== "all" ? "text-app-text" : ""}`} title="Filter by status">
              {STATUS_FILTER_LABELS[statusFilter]}
            </button>
          </th>
          {(
            [
              ["time", "Time", "right"],
              ["fuel", "Fuel used", "right"],
              ["wear", "Tyre wear", "right"],
            ] as [SortKey, string, "left" | "right"][]
          ).map(([key, label, align]) => (
            <th key={key} className={`px-3 py-1 font-medium ${align === "left" ? "text-left" : "text-right"}`}>
              <button
                type="button"
                onClick={() => toggleSort(key)}
                className={`uppercase tracking-wider hover:text-app-text ${sort.key === key ? "text-app-text" : ""}`}
                title={`Sort by ${label.toLowerCase()}`}
              >
                {label}
                {sort.key === key && <span className="ml-1">{sort.dir === 1 ? "▲" : "▼"}</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-app-border/30">
        {sortedLaps.map((l) => {
          const isFastest = bestT != null && l.isValid && l.lapTime === bestT;
          const metric = metricsById.get(l.id);
          const fuel = metric?.fuelPerLap;
          const wear = metric?.tyreWear;
          const excluded = l.experimentExcluded === true;
          // A user-excluded lap says so in the Status column — that's the reason
          // it's struck through, and it outranks any detector reason.
          const status = excluded ? "Excluded by user" : lapStatusLabel(l);
          const isPitStatus = !excluded && status != null && status.toLowerCase() !== "invalid";
          const reason = selection.reasonById.get(l.id);
          const strike = excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "";
          return (
            <tr key={l.id}>
              <td className={`px-3 py-1 font-mono ${strike} ${l.isValid ? "text-app-text-muted" : "text-status-danger"}`} title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}>
                {showSession && (
                  <span className="text-app-text-dim mr-1" title={`Imported from session ${l.sessionId}`}>
                    S{l.sessionId}·
                  </span>
                )}
                {l.lapNumber}
              </td>
              {/* Fixed-width status slot first, then the exclude toggle and the
                  eval badges: status is borderless text, and reserving its width
                  keeps the controls to its right in one column across rows. */}
              <td className="px-3 py-1 text-left">
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
                    {/* Which laps the analysis actually reads. "Eval" is the
                    positive signal users asked for; the capped case is called
                    out separately so a clean lap that merely lost the
                    fastest-N ranking doesn't read as a rejected lap. These are
                    status of the lap too, so they sit with the status text and
                    not next to the exclude control. */}
                    {reason === "chosen" && (
                      <span className="text-app-caption uppercase tracking-wider text-status-success" title={`Used for evaluation — one of the fastest ${REVIEW_LAP_CAP} clean laps this analysis reads`}>
                        Eval
                      </span>
                    )}
                    {reason === "slower-than-cap" && (
                      <span className="text-app-caption uppercase tracking-wider text-app-text-dim" title={`Clean lap, but outside the fastest ${REVIEW_LAP_CAP} — not used for evaluation`}>
                        Outside top {REVIEW_LAP_CAP}
                      </span>
                    )}
                  </span>
                  {/* Invalid laps are already out of the analysis by rule
                    (selectEvaluationLaps → "invalid"), so a manual exclude
                    toggle there is a no-op control — hide it. */}
                  {l.isValid && (
                    <button
                      type="button"
                      onClick={() => setExcluded.mutate({ lapId: l.id, excluded: !excluded, experimentId })}
                      disabled={setExcluded.isPending}
                      title={excluded ? "Include this lap in the tuning aggregate again" : "Exclude this lap from the tuning aggregate (blunder, off-track, spin)"}
                      className={`text-app-caption uppercase tracking-wider px-1.5 py-0.5 rounded border disabled:opacity-50 disabled:pointer-events-none ${
                        excluded ? "border-app-border text-app-text-dim opacity-60" : "border-app-border text-app-text hover:bg-app-surface-hover/30"
                      }`}
                    >
                      {excluded ? "Excluded" : "Exclude"}
                    </button>
                  )}
                </div>
              </td>
              {/* Fastest lap is marked by colouring the time itself purple. */}
              <td className={`px-3 py-1 text-right font-mono tabular-nums ${isFastest ? "text-(--lap-pace-best)" : "text-app-text/90"} ${strike}`}>{formatLapTime(l.lapTime)}</td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{fuel != null ? `${fuel.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{wear != null ? `${wear.toFixed(0)}%` : <span className="text-app-text-dim">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
