import { TBody, TD, TH, THead, TRow, Table } from "@/components/ui/AppTable";
import { useLaptimes } from "@/hooks/queries";
import { tracksMatch } from "@/lib/track-match";
import { useMemo } from "react";

// Parse a "M:SS.mmm" / "MM:SS.mmm" lap time into seconds for sorting.
// Returns Infinity for unparseable strings so they sink to the bottom.
function lapSeconds(t: string): number {
  const m = t.match(/(?:(\d+):)?(\d+)(?:[.:](\d+))?/);
  if (!m) return Number.POSITIVE_INFINITY;
  const min = m[1] ? Number(m[1]) : 0;
  const sec = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return min * 60 + sec + frac;
}

/**
 * Community reference lap times for a track, sourced from the CDN leaderboard
 * (`useLaptimes`, scoped to the active game via the X-Game-Id header). Purely a
 * reference dataset — never joined onto individual laps or tunes. Renders its
 * own empty state so it can drop straight into the laps-tab leaderboard panel.
 */
export function CommunityLeaderboard({ trackName, trackVariant }: { trackName: string; trackVariant: string }) {
  const { data: laptimes = [] } = useLaptimes();

  const rows = useMemo(() => {
    const matched = laptimes.filter((e) => tracksMatch(e.track, trackName, trackVariant));
    return [...matched].sort((a, b) => lapSeconds(a.laptime) - lapSeconds(b.laptime));
  }, [laptimes, trackName, trackVariant]);

  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm text-center px-4">No leaderboard yet</div>;
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
      <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2 shrink-0">Community Leaderboard ({rows.length})</div>
      <div className="overflow-y-auto flex-1">
        <Table fit>
          <THead>
            <TH>Car</TH>
            <TH>Driver</TH>
            <TH className="text-right">Time</TH>
          </THead>
          <TBody>
            {rows.map((e, i) => (
              <TRow key={`${e.car}-${e.driver}-${e.laptime}-${i}`}>
                <TD className="font-medium">{e.car}</TD>
                <TD className="text-app-text-secondary">{e.driver || "—"}</TD>
                <TD className="text-right font-mono text-app-text">{e.laptime}</TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
