import { useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLaptimes } from "@/hooks/tunes";
import { tracksMatch } from "@/lib/track-match";
import { m } from "@/paraglide/messages";

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
    const ranked = [...matched].sort((a, b) => lapSeconds(a.laptime) - lapSeconds(b.laptime));
    const seen = new Map<string, number>();
    return ranked.map((entry) => {
      const rowSeed = `${entry.track}|${entry.car}|${entry.driver || ""}|${entry.carClass}|${entry.laptime}`;
      const dup = seen.get(rowSeed) ?? 0;
      seen.set(rowSeed, dup + 1);
      return { ...entry, rowKey: `${rowSeed}#${dup}` };
    });
  }, [laptimes, trackName, trackVariant]);

  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-app-text-dim text-sm text-center px-4">{m.leaderboard_no_data()}</div>;
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
      <div className="mb-2 shrink-0">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider">
          {m.leaderboard_community()} ({rows.length})
        </div>
        <div className="text-xs text-app-text-dim">{m.leaderboard_unverified()}</div>
      </div>
      <div className="overflow-y-auto flex-1">
        <Table className="w-full text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40">
          <TableHeader>
            <TableRow className="text-app-label uppercase tracking-wider text-app-text-muted border-b border-app-border">
              <TableHead>{m.communityleaderboard_car()}</TableHead>
              <TableHead>{m.communityleaderboard_driver()}</TableHead>
              <TableHead className="text-right">{m.communityleaderboard_time()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.rowKey} className="group/row relative transition-colors hover:bg-app-surface-hover/50">
                <TableCell className="px-3 py-2 font-semibold text-app-text">{e.car}</TableCell>
                <TableCell className="px-3 py-2 text-app-text-secondary">{e.driver || "—"}</TableCell>
                <TableCell className="px-3 py-2 text-right font-mono tabular-nums text-app-accent">{e.laptime}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
