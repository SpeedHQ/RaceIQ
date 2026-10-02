import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

interface LeaderboardEntry {
  rank: number;
  date: string;
  lapTime: string;
  player: string;
  team: string;
  sessionType: string;
}

interface F125TrackData {
  leaderboard?: LeaderboardEntry[];
}

interface F125TrackSummary {
  trackSlug: string;
  trackOrdinal: number;
}

export function F125Leaderboard({ trackOrdinal }: { trackOrdinal: number }) {
  const { data: tracks = [] } = useQuery<F125TrackSummary[]>({
    queryKey: ["f125-tracks"],
    queryFn: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find((t) => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then((r) => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  const leaderboard = trackData?.leaderboard;
  if (!leaderboard?.length) return null;

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
      <div className="flex items-center gap-2 mb-2 shrink-0">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider">{m.f125lb_f1laps_leaderboard()}</div>
        <a href={`https://www.f1laps.com/f1-25/leaderboard/${trackSlug}/`} target="_blank" rel="noopener noreferrer" className="text-app-compact hover:underline">
          {m.f125lb_view_full()}
        </a>
      </div>
      <div className="overflow-y-auto flex-1">
        <Table className="w-full">
          <TableHeader>
            <TableRow>
              <TableHead>{m.f125lb_player()}</TableHead>
              <TableHead>{m.f125lb_team()}</TableHead>
              <TableHead className="text-right">{m.label_time()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaderboard.map((e) => (
              <TableRow key={e.rank}>
                <TableCell className="font-semibold">{e.player}</TableCell>
                <TableCell>{e.team}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{e.lapTime}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
