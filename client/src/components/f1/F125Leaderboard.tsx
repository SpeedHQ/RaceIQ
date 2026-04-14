import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { Table, THead, TH, TBody, TRow, TD } from "@/components/ui/AppTable";

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
    queryFn: () => client.api["f1-25"].tracks.$get().then(r => r.json() as unknown as F125TrackSummary[]),
  });

  const trackSlug = tracks.find(t => t.trackOrdinal === trackOrdinal)?.trackSlug;

  const { data: trackData } = useQuery<F125TrackData>({
    queryKey: ["f125-setups", trackSlug],
    queryFn: () => client.api["f1-25"].setups.$get({ query: { track: trackSlug! } }).then(r => r.json() as unknown as F125TrackData),
    enabled: !!trackSlug,
  });

  const leaderboard = trackData?.leaderboard;
  if (!leaderboard?.length) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider">
          F1Laps Leaderboard
        </div>
        <a
          href={`https://www.f1laps.com/f1-25/leaderboard/${trackSlug}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-app-unit text-app-accent hover:underline"
        >
          View Full
        </a>
      </div>
      <Table>
        <THead>
          <TH className="w-6">#</TH>
          <TH>Player</TH>
          <TH>Team</TH>
          <TH>Session</TH>
          <TH className="text-right">Time</TH>
        </THead>
        <TBody>
          {leaderboard.map((e) => (
            <TRow key={e.rank}>
              <TD className="font-mono text-app-text-dim">{e.rank}</TD>
              <TD className="font-medium">{e.player}</TD>
              <TD className="text-app-text-secondary">{e.team}</TD>
              <TD className="text-app-text-dim">{e.sessionType}</TD>
              <TD className="text-right font-mono text-emerald-400">{e.lapTime}</TD>
            </TRow>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
