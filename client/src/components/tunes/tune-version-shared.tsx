import type { LapMeta } from "@shared/types";
import { useMemo } from "react";
import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/review-laps";
import { type TuningLapMetric, useSetLapExcluded } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";

/**
 * Shared rendering pieces for a tuning test ("setup version"): the
 * applied-changes summary and the per-lap breakdown table. Both
 * TuningSessionWorkspace (legacy flat list, kept for reference/tests) and
 * VersionGraph (the commit-graph view, Task 11) render the same version rows,
 * so this lives in its own module rather than being exported from either
 * component — VersionGraph importing from TuningSessionWorkspace (or vice
 * versa) would create a circular import between the two.
 */

interface AppliedChangeDto {
  component: string;
  from: number;
  to: number;
  direction?: string;
  reason?: string;
}

/** Parse the stored appliedChanges JSON into a typed list (empty on any issue). */
export function parseAppliedChanges(json: string | null | undefined): AppliedChangeDto[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as AppliedChangeDto[]) : [];
  } catch {
    return [];
  }
}

/** One-line summary of a version's tweaks for collapsed tree rows, e.g.
 *  "+1 rear wing, softer rear ARB". Prefers the stored direction word when
 *  present, otherwise falls back to the signed numeric delta. Null when the
 *  version has no applied changes (base setup). */
export function summarizeAppliedChanges(json: string | null | undefined): string | null {
  const changes = parseAppliedChanges(json);
  if (changes.length === 0) return null;
  return changes
    .map((c) => {
      if (c.direction) return `${c.direction} ${c.component}`;
      const delta = c.to - c.from;
      if (Number.isFinite(delta) && delta !== 0) return `${delta > 0 ? "+" : ""}${+delta.toFixed(2)} ${c.component}`;
      return c.component;
    })
    .join(", ");
}

/** What was tweaked for a setup version — rendered in the expanded version row
 *  and (live) in the chat after Generate. Base versions have no changes. */
export function AppliedChangesList({ json, comment }: { json: string | null; comment?: string | null }) {
  const changes = parseAppliedChanges(json);
  if (changes.length === 0 && !comment) return null;
  return (
    <div className="px-3 py-2 border-b border-app-border/40 space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Tweaks</div>
      {changes.length === 0 ? (
        <div className="text-[11px] text-app-text-dim">Base setup — no changes applied.</div>
      ) : (
        <ul className="space-y-0.5">
          {changes.map((c, i) => (
            <li key={`${c.component}-${i}`} className="text-[11px] text-app-text">
              <span className="font-mono text-purple-400">{c.component}</span>{" "}
              <span className="tabular-nums text-app-text-dim">
                {c.from} → {c.to}
              </span>
              {c.reason && <span className="text-app-text-dim"> · {c.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {comment && <div className="text-[11px] text-app-text-dim italic">Driver: “{comment}”</div>}
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

/** Per-lap breakdown for an expanded tune test. Fuel/lap and tyre wear are the
 *  real server-derived numbers (or "—" for legacy/unavailable laps, e.g. when the
 *  server omits a channel); the spun flag is omitted (parity Phase 2). */
export function LapBreakdown({
  laps,
  bestT,
  metricsById,
  tuningSessionId,
}: {
  laps: LapMeta[];
  bestT: number | null;
  metricsById: Map<number, TuningLapMetric>;
  /** Session to invalidate after toggling exclusion (design §Phase 7). Laps
   *  outside a tuning session (no exclude toggle context) can omit this. */
  tuningSessionId?: number | null;
}) {
  const setExcluded = useSetLapExcluded();
  // Same selector the server's auto-exclude pass and /line-spread use, so the
  // badges here can't drift from the laps actually fed to the analysis.
  // Must run before the early return below (rules of hooks).
  const selection = useMemo(() => selectEvaluationLaps(laps), [laps]);
  if (laps.length === 0) {
    return <div className="px-3 py-2 text-xs text-app-text-dim">No laps recorded against this version yet.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-app-text-muted">
          <th className="px-3 py-1 text-left font-medium">Lap</th>
          <th className="px-3 py-1 text-left font-medium">Status</th>
          <th className="px-3 py-1 text-right font-medium">Time</th>
          <th className="px-3 py-1 text-right font-medium">Fuel used (L)</th>
          <th className="px-3 py-1 text-right font-medium">Tyre wear</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-app-border/30">
        {laps.map((l) => {
          const isFastest = bestT != null && l.isValid && l.lapTime === bestT;
          const metric = metricsById.get(l.id);
          const fuel = metric?.fuelPerLap;
          const wear = metric?.tyreWear;
          const status = lapStatusLabel(l);
          const isPitStatus = status != null && status.toLowerCase() !== "invalid";
          const excluded = l.tuningExcluded === true;
          const reason = selection.reasonById.get(l.id);
          const strike = excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "";
          return (
            <tr key={l.id}>
              <td className={`px-3 py-1 font-mono ${strike} ${l.isValid ? "text-app-text-muted" : "text-red-400"}`} title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}>
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
                    className={`text-[10px] uppercase tracking-wider truncate ${strike} ${isPitStatus ? "text-amber-400" : "text-red-400"}`}
                    title={l.invalidReason ?? undefined}
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
                  <span
                    className="text-[10px] uppercase tracking-wider text-emerald-400"
                    title={`Used for evaluation — one of the fastest ${REVIEW_LAP_CAP} clean laps this analysis reads`}
                  >
                    Eval
                  </span>
                )}
                {reason === "slower-than-cap" && (
                  <span
                    className="text-[10px] uppercase tracking-wider text-app-text-dim"
                    title={`Clean lap, but outside the fastest ${REVIEW_LAP_CAP} — not used for evaluation`}
                  >
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
                  onClick={() => setExcluded.mutate({ lapId: l.id, excluded: !excluded, tuningSessionId })}
                  disabled={setExcluded.isPending}
                  title={excluded ? "Include this lap in the tuning aggregate again" : "Exclude this lap from the tuning aggregate (blunder, off-track, spin)"}
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border disabled:opacity-50 disabled:pointer-events-none ${
                    excluded ? "border-app-border text-app-text-dim opacity-60" : "border-app-border text-app-text hover:bg-app-border/30"
                  }`}
                >
                  {excluded ? "Excluded" : "Exclude"}
                </button>
                )}
                </div>
              </td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>
                {isFastest && <span className="text-purple-400">★ </span>}
                {formatLapTime(l.lapTime)}
              </td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{fuel != null ? `${fuel.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{wear != null ? `${wear.toFixed(0)}%` : <span className="text-app-text-dim">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
