import type { RaceResult, RaceResultAggregate, RaceResultOutcomeStatus, RaceResultStatus } from "@shared/racing/results/types";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GameId } from "../../../../shared/games/ids";
import { client } from "../../lib/rpc";

const labels: Record<RaceResultStatus, string> = {
  finished: "Finished",
  dnf: "DNF",
  retired: "Retired",
  qualifying: "Qualifying",
  unknown: "Unknown",
};

export function ResultStatusBadge({ status }: { status: RaceResultStatus }) {
  return <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{labels[status]}</span>;
}

export function ResultAggregateGrid({ aggregate }: { aggregate: RaceResultAggregate }) {
  const rows: Array<[string, number | string]> = [
    ["Results", aggregate.sessions],
    ["Finished", aggregate.finished],
    ["DNF / retired", aggregate.dnf + aggregate.retired],
    ["Qualifying", aggregate.qualifying],
    ["Unknown", aggregate.unknown],
    ["Podiums", aggregate.podiums],
    ["Fastest laps", aggregate.fastestLaps],
    ["Pit stops", aggregate.pitStops],
    ["Pit time", aggregate.pitDurationSeconds == null ? "Unknown" : `${aggregate.pitDurationSeconds.toFixed(1)}s`],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-md border border-border/60 px-3 py-2">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}
export function RaceResultSummary({ gameId, title = "Race results", trackOrdinal }: { gameId: GameId | null; title?: string; trackOrdinal?: number }) {
  const query = useQuery({
    queryKey: ["race-result-summary", gameId, trackOrdinal],
    enabled: gameId != null,
    queryFn: async () => {
      if (!gameId) return null;
      const response = await client.api["race-results"].summary.$get({
        query: { gameId, trackOrdinal: trackOrdinal == null ? undefined : String(trackOrdinal) },
      });
      if (!response.ok) throw new Error(response.statusText);
      return response.json() as Promise<RaceResultAggregate>;
    },
  });
  const recentQuery = useQuery({
    queryKey: ["race-result-recent", gameId],
    enabled: gameId != null && trackOrdinal == null,
    queryFn: async () => {
      if (!gameId) return [] as RaceResult[];
      const response = await client.api["race-results"].recent.$get({ query: { gameId, limit: "5" } });
      if (!response.ok) throw new Error(response.statusText);
      return response.json() as Promise<RaceResult[]>;
    },
  });
  if (!gameId || query.isLoading) return null;
  if (query.isError || !query.data || query.data.sessions === 0) {
    return (
      <section className="rounded-lg border border-border/60 p-4">
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">No persisted result data yet.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border/60 p-4">
      <h2 className="mb-3 font-medium">{title}</h2>
      <ResultAggregateGrid aggregate={query.data} />
      {recentQuery.data && recentQuery.data.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium">Recent sessions</h3>
          {recentQuery.data.map((result) => (
            <div key={result.id} className="flex items-center justify-between gap-2 text-sm">
              <span>Session {result.sessionId}</span>
              <span className="flex items-center gap-2">
                <ResultStatusBadge status={result.classification} />
                {result.isPodium && <span className="text-xs text-muted-foreground">Podium</span>}
                {result.isFastestLap && <span className="text-xs text-muted-foreground">Fastest lap</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
