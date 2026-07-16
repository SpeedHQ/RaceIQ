import type { LapMeta } from "@shared/types";
import type { TuningLapMetric } from "../../hooks/queries";
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

/** Per-lap breakdown for an expanded tune test. Fuel/lap is the real
 *  server-derived number (or "—" for legacy/unavailable laps); tyre wear stays
 *  "—" (no ACC/AC-Evo channel); the spun flag is omitted (parity Phase 2). */
export function LapBreakdown({ laps, bestT, metricsById }: { laps: LapMeta[]; bestT: number | null; metricsById: Map<number, TuningLapMetric> }) {
  if (laps.length === 0) {
    return <div className="px-3 py-2 text-xs text-app-text-dim">No laps recorded against this version yet.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-app-text-muted">
          <th className="px-3 py-1 text-left font-medium">Lap</th>
          <th className="px-3 py-1 text-right font-medium">Time</th>
          <th className="px-3 py-1 text-right font-medium">Fuel/lap</th>
          <th className="px-3 py-1 text-right font-medium">Tyre wear</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-app-border/30">
        {laps.map((l) => {
          const isFastest = bestT != null && l.isValid && l.lapTime === bestT;
          const fuel = metricsById.get(l.id)?.fuelPerLap;
          return (
            <tr key={l.id}>
              <td className={`px-3 py-1 font-mono ${l.isValid ? "text-app-text-muted" : "text-red-400"}`} title={!l.isValid ? (l.invalidReason ?? "invalid") : undefined}>
                {!l.isValid && <span className="mr-1">✕</span>}
                {l.lapNumber}
              </td>
              <td className="px-3 py-1 text-right font-mono tabular-nums text-app-text/90">
                {isFastest && <span className="text-purple-400">★ </span>}
                {formatLapTime(l.lapTime)}
              </td>
              <td className="px-3 py-1 text-right font-mono tabular-nums text-app-text/90">{fuel != null ? `${fuel.toFixed(2)} L` : <span className="text-app-text-dim">—</span>}</td>
              <td className="px-3 py-1 text-right text-app-text-dim">—</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
