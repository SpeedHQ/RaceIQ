import type { RaceResult } from "@shared/race-results";
import type { GameId } from "@shared/types";
import { useSessionResult } from "../../hooks/queries";

type RaceResultTimelineNode =
  | { kind: "start" }
  | {
      kind: "pit";
      sequence: number;
      lapNumber: number | null;
      durationSeconds: number | null;
      service: RaceResult["events"][number]["service"];
      tyreChange: unknown;
      fuelAdded: number | null;
    }
  | {
      kind: "finish";
      classification: RaceResult["classification"];
      finishingPosition: number | null;
      qualifyingPosition: number | null;
    };

export function buildRaceResultTimeline(result: RaceResult): RaceResultTimelineNode[] {
  return [
    { kind: "start" },
    ...result.events
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => ({
        kind: "pit" as const,
        sequence: event.sequence,
        lapNumber: event.lapNumber,
        durationSeconds: event.durationSeconds,
        service: event.service,
        tyreChange: event.tyreChange,
        fuelAdded: event.fuelAdded,
      })),
    {
      kind: "finish",
      classification: result.classification,
      finishingPosition: result.finishingPosition,
      qualifyingPosition: result.qualifyingPosition,
    },
  ];
}

function formatService(service: RaceResult["events"][number]["service"]): string {
  return service === "unknown" ? "Service" : service[0].toUpperCase() + service.slice(1);
}

function tyreChangeLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const change = value as { from?: unknown; to?: unknown };
  if (typeof change.from === "string" && typeof change.to === "string") return `${change.from} → ${change.to}`;
  if (typeof change.to === "string") return `→ ${change.to}`;
  return null;
}

function TimelineNode({ node }: { node: RaceResultTimelineNode }) {
  if (node.kind === "start") {
    return (
      <div className="min-w-28 rounded-md border border-app-border bg-app-surface px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-app-text/60">Start</div>
        <div className="mt-1 text-xs text-app-text/90">Session begins</div>
      </div>
    );
  }

  if (node.kind === "finish") {
    const position = node.finishingPosition ?? node.qualifyingPosition;
    return (
      <div className="min-w-32 rounded-md border border-status-success/40 bg-status-success/10 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-status-success">Finish</div>
        <div className="mt-1 text-xs font-medium text-app-text">{node.classification[0].toUpperCase() + node.classification.slice(1)}</div>
        {position != null && <div className="text-xs text-app-text/70">P{position}</div>}
      </div>
    );
  }

  const tyre = tyreChangeLabel(node.tyreChange);
  return (
    <div className="min-w-36 rounded-md border border-app-accent/40 bg-app-accent/10 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-app-accent">{formatService(node.service)}</div>
      {node.lapNumber != null && <div className="mt-1 text-xs font-medium text-app-text">Lap {node.lapNumber}</div>}
      {node.durationSeconds != null && <div className="text-xs text-app-text/70">{node.durationSeconds.toFixed(1)}s stop</div>}
      {tyre && <div className="text-xs text-app-text/70">{tyre}</div>}
      {node.fuelAdded != null && <div className="text-xs text-app-text/70">+{node.fuelAdded.toFixed(1)} fuel</div>}
    </div>
  );
}

export function RaceResultLedger({ sessionId, gameId, enabled }: { sessionId: number; gameId: GameId; enabled: boolean }) {
  const resultQuery = useSessionResult(sessionId, gameId, enabled);

  if (resultQuery.isLoading) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">Loading race timeline…</div>;
  if (resultQuery.isError) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">Race timeline unavailable.</div>;
  if (!resultQuery.data) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">No race timeline recorded.</div>;

  const nodes = buildRaceResultTimeline(resultQuery.data);
  return (
    <section aria-label="Race timeline" className="border-b border-app-border bg-app-surface-alt/20 px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-app-text/60">Race timeline</div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-center">
          {nodes.map((node, index) => (
            <div key={node.kind === "pit" ? `pit-${node.sequence}` : node.kind} className="flex items-center">
              <TimelineNode node={node} />
              {index < nodes.length - 1 && <div aria-hidden="true" className="h-px w-8 bg-app-border" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
