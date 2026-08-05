import type { RaceResult } from "@shared/race-results";
import type { GameId } from "@shared/types";
import { useSessionResult } from "../../hooks/queries";

type RaceResultTimelineNode =
  | { kind: "start"; position: number | null }
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
      kind: "position";
      sequence: number;
      lapNumber: number | null;
      direction: "up" | "down";
      position: number | null;
    }
  | {
      kind: "finish";
      classification: RaceResult["classification"];
      finishingPosition: number | null;
      qualifyingPosition: number | null;
    };

export function buildRaceResultTimeline(result: RaceResult): RaceResultTimelineNode[] {
  return [
    { kind: "start", position: result.qualifyingPosition },
    ...result.events
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => {
        if (event.eventType === "position-change") {
          return {
            kind: "position" as const,
            sequence: event.sequence,
            lapNumber: event.lapNumber,
            direction: (event.positionAfter != null && event.positionBefore != null && event.positionAfter < event.positionBefore ? "up" : "down") as "up" | "down",
            position: event.positionAfter ?? null,
          };
        }
        return {
          kind: "pit" as const,
          sequence: event.sequence,
          lapNumber: event.lapNumber,
          durationSeconds: event.durationSeconds,
          service: event.service,
          tyreChange: event.tyreChange,
          fuelAdded: event.fuelAdded,
        };
      }),
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

function FinishFlag() {
  return (
    <svg aria-label="Finish flag" className="h-5 w-5 text-status-success" viewBox="0 0 24 24" fill="none" role="img">
      <path d="M6 21V4m0 1h11l-2 3 2 3H6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5h2v2H8zm4 0h2v2h-2zM8 9h2v2H8zm4 0h2v2h-2z" fill="currentColor" />
    </svg>
  );
}

function TimelineNode({ node }: { node: RaceResultTimelineNode }) {
  if (node.kind === "start") {
    return (
      <div className="min-w-32 rounded-xl border border-app-border/80 bg-app-surface px-4 py-3 shadow-sm shadow-black/20">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-app-text/55">Start</div>
        <div className="mt-1 text-sm font-semibold text-app-text">{node.position != null ? `Grid P${node.position}` : "Session begins"}</div>
      </div>
    );
  }

  if (node.kind === "position") {
    return (
      <div
        className={`min-w-28 rounded-xl border px-4 py-3 shadow-sm shadow-black/20 ${node.direction === "up" ? "border-status-success/50 bg-status-success/10" : "border-status-danger/50 bg-status-danger/10"}`}
      >
        <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${node.direction === "up" ? "text-status-success" : "text-status-danger"}`}>Position</div>
        {node.lapNumber != null && <div className="mt-1 text-xs text-app-text/65">End lap {node.lapNumber}</div>}
        <div className="mt-0.5 text-lg font-bold leading-none text-app-text">
          <span className="sr-only">
            {node.direction === "up" ? "Gained" : "Lost"} position{node.position != null ? ` to P${node.position}` : ""}
          </span>
          <span aria-hidden="true">
            {node.direction === "up" ? "↑" : "↓"}
            {node.position != null && <span className="ml-1 text-sm">P{node.position}</span>}
          </span>
        </div>
      </div>
    );
  }

  if (node.kind === "finish") {
    const position = node.finishingPosition ?? node.qualifyingPosition;
    return (
      <div className="min-w-36 rounded-xl border border-status-success/50 bg-status-success/10 px-4 py-3 shadow-sm shadow-black/20">
        <div className="flex items-center gap-2">
          <FinishFlag />
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-status-success">Finish</div>
        </div>
        <div className="mt-1 text-sm font-semibold text-app-text">{node.classification[0].toUpperCase() + node.classification.slice(1)}</div>
        {position != null && <div className="text-xs text-app-text/70">P{position}</div>}
      </div>
    );
  }

  const tyre = tyreChangeLabel(node.tyreChange);
  return (
    <div className="min-w-40 rounded-xl border border-app-accent/50 bg-app-accent/10 px-4 py-3 shadow-sm shadow-black/20">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-app-accent">{formatService(node.service)}</div>
      {node.lapNumber != null && <div className="mt-1 text-sm font-semibold text-app-text">Lap {node.lapNumber}</div>}
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
    <section aria-label="Race timeline" className="border-b border-app-border bg-app-surface-alt/20 px-4 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-app-text/55">Race timeline</div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-center">
          {nodes.map((node, index) => (
            <div key={node.kind === "pit" || node.kind === "position" ? `${node.kind}-${node.sequence}` : node.kind} className="flex items-center">
              <TimelineNode node={node} />
              {index < nodes.length - 1 && <div aria-hidden="true" className="mx-2 h-px w-10 bg-app-border/80" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
