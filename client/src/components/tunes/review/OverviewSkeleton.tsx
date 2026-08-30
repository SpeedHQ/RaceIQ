import { headlineMetricForVersionKind, type VersionKind } from "@shared/racing/experiments/focus";
import type { LapMeta } from "@shared/racing/sessions/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { formatLapTime } from "@/lib/format";

/**
 * The headline read for THIS arm, judged on its own terms.
 *
 * A setup arm is meant to move outright pace, so best lap leads. A drill is
 * meant to make the driver repeatable — its win condition can be a tighter
 * spread at an unchanged best lap, which a best-lap headline scores as "no
 * change". Both numbers stay on screen either way; only which one leads
 * changes, so nothing is hidden from a driver who wants the other read.
 */
export function ArmHeadline({ kind, laps }: { kind: VersionKind; laps: LapMeta[] }) {
  const times = laps.map((l) => l.lapTime).filter((t) => t > 0);
  const best = times.length ? Math.min(...times) : null;
  // Spread, not standard deviation: with the 3–8 laps a stint actually
  // produces, "my worst lap was 0.4s off my best" is a number a driver can act
  // on, and σ over that few samples is noise wearing a statistic's clothes.
  const spread = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
  const metric = headlineMetricForVersionKind(kind);

  const lead = metric === "consistency" ? { label: "Lap-time spread", value: spread != null ? `${spread.toFixed(3)}s` : "—" } : { label: "Best lap", value: best != null ? formatLapTime(best) : "—" };
  const secondary = metric === "consistency" ? { label: "Best lap", value: best != null ? formatLapTime(best) : "—" } : { label: "Spread", value: spread != null ? `${spread.toFixed(3)}s` : "—" };

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-app-border px-4 py-2.5">
      <Badge
        variant={kind === "drill" ? "warning" : "info"}
        className="review-kind-badge"
        data-review-kind={kind}
        title={kind === "drill" ? "A driving drill — judged on consistency" : "A setup version — judged on best lap"}
      >
        {kind === "drill" ? "Driving drill" : "Setup version"}
      </Badge>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{lead.label}</div>
        <div className="font-mono text-sm text-app-text tabular-nums">{lead.value}</div>
      </div>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{secondary.label}</div>
        <div className="font-mono text-sm text-app-text-dim tabular-nums">{secondary.value}</div>
      </div>
      <div>
        <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Valid laps</div>
        <div className="font-mono text-sm text-app-text-dim tabular-nums">{times.length}</div>
      </div>
    </div>
  );
}

/** Empty review shown before a recorded lap is available for post-lap analysis. */
export function ReviewOverviewSkeleton({ trackName, sectorStarts, onBack }: { trackName?: string; sectorStarts?: number[] | null; onBack?: () => void }) {
  return (
    <div>
      {/* Toolbar — mirrors the real one; controls disabled with no lap loaded. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-app-border">
        {onBack && (
          <Button variant="app-outline" size="app-sm" onClick={onBack}>
            ← Session
          </Button>
        )}
        <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Post-lap</span>
        <div className="bg-app-surface-alt border border-app-border rounded px-2 py-1 text-sm font-mono text-app-text-dim">No laps yet</div>
        <div className="flex gap-1">
          {["overview", ...(sectorStarts?.map((_, index) => `s${index + 1}`) ?? []), "track"].map((view) => (
            <span key={view} className={`px-2.5 py-1 text-xs rounded border ${view === "overview" ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-dim"}`}>
              {view === "overview" ? "Overview" : view === "track" ? "Track" : `Sector ${view.slice(1)}`}
            </span>
          ))}
        </div>
        {trackName && <span className="ml-auto hidden text-xs text-app-text-muted @5xl/workspace:inline">{trackName}</span>}
      </div>

      <div className="border-b border-app-border">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-app-border">
          <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sectors</span>
        </div>
        {sectorStarts?.length ? (
          <div className="grid grid-cols-1 @3xl/workspace:grid-cols-3">
            {sectorStarts.map((start, index) => {
              const from = index === 0 ? 0 : start;
              const to = sectorStarts[index + 1] ?? 1;
              return (
                <div key={index} className="border-t border-app-border p-3 first:border-t-0 @3xl/workspace:border-t-0 @3xl/workspace:border-r last:border-r-0">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLOR_VARS[index % SECTOR_COLOR_VARS.length] }} />
                    <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sector {index + 1}</span>
                    <span className="ml-auto text-xs font-mono text-app-text-dim">
                      {(from * 100).toFixed(1)}%–{(to * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xl font-mono tabular-nums text-app-text-dim mt-1.5">—</div>
                  <div className="mt-2 aspect-video rounded border border-dashed border-app-border grid place-items-center text-xs text-app-text-dim">No lap telemetry</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-6 text-sm text-app-text-dim">Sector layout will load from track data or live simulator telemetry when available.</div>
        )}
      </div>

      <div className="px-4 py-6 text-sm text-app-text-dim">Drive a stint and finish a lap — your recorded laps and their sector breakdown will appear here.</div>
    </div>
  );
}
