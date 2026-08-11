import type { GameId } from "@shared/games/ids";
import type { RaceResult } from "@shared/racing/results/types";
import { useSessionResult } from "@/hooks/session-queries";
import { cn } from "@/lib/utils";

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

const RESULT_PRESENTATION: Record<RaceResult["classification"], { label: string; surfaceClassName: string; accentClassName: string }> = {
  finished: {
    label: "Finish",
    surfaceClassName: "border-status-success/50 bg-status-success/10",
    accentClassName: "text-status-success",
  },
  dnf: {
    label: "DNF",
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  retired: {
    label: "Retired",
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  disqualified: {
    label: "Disqualified",
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  "not-classified": {
    label: "Not classified",
    surfaceClassName: "border-status-warning/50 bg-status-warning/10",
    accentClassName: "text-status-warning",
  },
  qualifying: {
    label: "Qualifying",
    surfaceClassName: "border-status-info/50 bg-status-info/10",
    accentClassName: "text-status-info",
  },
  unknown: {
    label: "Result unavailable",
    surfaceClassName: "border-app-border bg-app-surface-alt",
    accentClassName: "text-app-text-muted",
  },
};

export function buildRaceResultTimeline(result: RaceResult): RaceResultTimelineNode[] {
  let currentPosition = result.qualifyingPosition;
  const eventNodes: RaceResultTimelineNode[] = [];
  for (const event of result.events.slice().sort((a, b) => a.sequence - b.sequence)) {
    if (event.eventType === "position-change") {
      const position = event.positionAfter ?? null;
      if (position == null) continue;
      if (currentPosition != null && position === currentPosition) continue;
      eventNodes.push({
        kind: "position",
        sequence: event.sequence,
        lapNumber: event.lapNumber,
        direction: currentPosition == null || position > currentPosition ? "down" : "up",
        position,
      });
      currentPosition = position;
      continue;
    }
    eventNodes.push({
      kind: "pit",
      sequence: event.sequence,
      lapNumber: event.lapNumber,
      durationSeconds: event.durationSeconds,
      service: event.service,
      tyreChange: event.tyreChange,
      fuelAdded: event.fuelAdded,
    });
  }
  return [
    { kind: "start", position: result.qualifyingPosition },
    ...eventNodes,
    {
      kind: "finish",
      classification: result.classification,
      finishingPosition: result.finishingPosition,
      qualifyingPosition: result.qualifyingPosition,
    },
  ];
}

export function formatService(service: RaceResult["events"][number]["service"]): string {
  return service === "unknown" ? "Pit" : service[0].toUpperCase() + service.slice(1);
}

function tyreChangeLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const change = value as { from?: unknown; to?: unknown };
  if (typeof change.from === "string" && typeof change.to === "string") return `${change.from} → ${change.to}`;
  if (typeof change.to === "string") return `→ ${change.to}`;
  return null;
}

function ResultFlag({ className }: { className: string }) {
  return (
    <svg aria-label="Result flag" className={cn("size-5", className)} viewBox="0 0 24 24" fill="none" role="img">
      <path d="M6 21V4m0 1h11l-2 3 2 3H6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5h2v2H8zm4 0h2v2h-2zM8 9h2v2H8zm4 0h2v2h-2z" fill="currentColor" />
    </svg>
  );
}

function TimelineNode({ node }: { node: RaceResultTimelineNode }) {
  if (node.kind === "start") {
    return (
      <div className="min-w-32 rounded-xl border border-app-border/80 bg-app-surface px-4 py-3 shadow-sm shadow-app-bg/20">
        <div className="text-app-caption font-semibold uppercase tracking-app-label text-app-text/55">Start</div>
        <div className="mt-1 text-sm font-semibold text-app-text">{node.position != null ? `Grid P${node.position}` : "Session begins"}</div>
      </div>
    );
  }

  if (node.kind === "position") {
    return (
      <div
        className={`min-w-28 rounded-xl border px-4 py-3 shadow-sm shadow-app-bg/20 ${node.direction === "up" ? "border-status-success/50 bg-status-success/10" : "border-status-danger/50 bg-status-danger/10"}`}
      >
        <div className={`text-app-caption font-semibold uppercase tracking-app-label ${node.direction === "up" ? "text-status-success" : "text-status-danger"}`}>Position</div>
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
    const presentation = RESULT_PRESENTATION[node.classification];
    return (
      <div className={cn("min-w-36 rounded-xl border px-4 py-3 shadow-sm shadow-app-bg/20", presentation.surfaceClassName)}>
        <div className="flex items-center gap-2">
          <ResultFlag className={presentation.accentClassName} />
          <div className={cn("text-app-caption font-semibold uppercase tracking-app-label", presentation.accentClassName)}>{presentation.label}</div>
        </div>
        {node.classification !== "qualifying" && node.finishingPosition != null && <div className="mt-1 text-xs text-app-text/70">Finish P{node.finishingPosition}</div>}
        {node.qualifyingPosition != null && <div className="mt-1 text-xs text-app-text/70">Qualified P{node.qualifyingPosition}</div>}
      </div>
    );
  }

  const tyre = tyreChangeLabel(node.tyreChange);
  return (
    <div className="min-w-40 rounded-xl border border-app-accent/50 bg-app-accent/10 px-4 py-3 shadow-sm shadow-app-bg/20">
      <div className="text-app-caption font-semibold uppercase tracking-app-label text-app-accent">{formatService(node.service)}</div>
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
      <div className="mb-3 text-app-caption font-semibold uppercase tracking-app-label text-app-text/55">Race timeline</div>
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
