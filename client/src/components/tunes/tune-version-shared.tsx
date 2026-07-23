import type { LapMeta } from "@shared/types";
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

/** Short label for the Status column. Pit-lane laps get their classification
 *  ("Outlap"/"Inlap"/"Pit lap"); other invalid reasons collapse to "Invalid"
 *  (full reason still in the row title); valid laps show nothing. */
function lapStatusLabel(l: LapMeta): string | null {
  if (l.isValid) return null;
  const reason = l.invalidReason ?? null;
  if (reason && PIT_STATUS_REASONS.has(reason)) return reason[0].toUpperCase() + reason.slice(1);
  return "Invalid";
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
          <th className="px-3 py-1 text-right font-medium">Fuel/lap</th>
          <th className="px-3 py-1 text-right font-medium">Tyre wear</th>
          <th className="px-3 py-1 text-right font-medium">Tuning</th>
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
          const strike = excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "";
          return (
            <tr key={l.id}>
              <td className={`px-3 py-1 font-mono ${strike} ${l.isValid ? "text-app-text-muted" : "text-red-400"}`} title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}>
                {l.lapNumber}
              </td>
              <td className="px-3 py-1 text-left">
                {status && (
                  <span className={`text-[10px] uppercase tracking-wider ${strike} ${isPitStatus ? "text-amber-400" : "text-red-400"}`} title={l.invalidReason ?? undefined}>
                    {status}
                  </span>
                )}
                {excluded && <span className="ml-1 text-[10px] uppercase tracking-wider text-app-text-dim border border-app-border rounded px-1 py-0.5">Excluded</span>}
              </td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>
                {isFastest && <span className="text-purple-400">★ </span>}
                {formatLapTime(l.lapTime)}
              </td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{fuel != null ? `${fuel.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums text-app-text/90 ${strike}`}>{wear != null ? `${wear.toFixed(0)}%` : <span className="text-app-text-dim">—</span>}</td>
              <td className="px-3 py-1 text-right">
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
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
