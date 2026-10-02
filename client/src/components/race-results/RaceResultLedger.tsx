import type { GameId } from "@raceiq/games/ids";
import type { RaceResult } from "@shared/racing/results/types";
import { isPracticeSession } from "@shared/racing/sessions/session-type";
import { useSessionResult } from "@/hooks/session-queries";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type RaceResultTimelineNode =
  | { kind: "qualifying"; position: number }
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
      kind: "penalty";
      sequence: number;
      lapNumber: number | null;
      penaltyType: string;
      penaltyTime: number;
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
    };

const RESULT_PRESENTATION: Record<RaceResult["classification"], { label: string; surfaceClassName: string; accentClassName: string }> = {
  finished: {
    label: m.race_result_finish(),
    surfaceClassName: "border-status-success/50 bg-status-success/10",
    accentClassName: "text-status-success",
  },
  dnf: {
    label: m.race_result_dnf(),
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  retired: {
    label: m.race_result_retired(),
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  disqualified: {
    label: m.race_result_disqualified(),
    surfaceClassName: "border-status-danger/50 bg-status-danger/10",
    accentClassName: "text-status-danger",
  },
  "not-classified": {
    label: m.race_result_not_classified(),
    surfaceClassName: "border-status-warning/50 bg-status-warning/10",
    accentClassName: "text-status-warning",
  },
  qualifying: {
    label: m.race_result_qualifying(),
    surfaceClassName: "border-status-info/50 bg-status-info/10",
    accentClassName: "text-status-info",
  },
  unknown: {
    label: m.race_result_unavailable(),
    surfaceClassName: "border-app-border bg-app-surface-alt",
    accentClassName: "text-app-text-muted",
  },
};

export function buildRaceResultTimeline(result: RaceResult): RaceResultTimelineNode[] {
  const practice = isPracticeSession(result.sessionType);
  const qualifyingPosition = practice ? null : result.qualifyingPosition;
  let currentPosition = qualifyingPosition;
  const eventNodes: RaceResultTimelineNode[] = [];
  for (const event of result.events.slice().sort((a, b) => a.sequence - b.sequence)) {
    if (event.eventType === "penalty") {
      const source = event.source as { penaltyType?: unknown; penaltyTime?: unknown } | null;
      eventNodes.push({
        kind: "penalty",
        sequence: event.sequence,
        lapNumber: event.lapNumber,
        penaltyType: typeof source?.penaltyType === "string"
          ? source.penaltyType.replace(/[-_]+/g, " ")
          : m.race_result_penalty(),
        penaltyTime: typeof source?.penaltyTime === "number" ? source.penaltyTime : 0,
      });
      continue;
    }
    if (event.eventType === "position-change") {
      if (practice) continue;
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
    ...(qualifyingPosition != null ? [{ kind: "qualifying" as const, position: qualifyingPosition }] : []),
    { kind: "start", position: qualifyingPosition },
    ...eventNodes,
    {
      kind: "finish",
      classification: result.classification,
      finishingPosition: practice ? null : result.finishingPosition,
    },
  ];
}

export function formatService(service: RaceResult["events"][number]["service"]): string {
  return service === "unknown" ? m.race_result_pit() : service[0].toUpperCase() + service.slice(1);
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
    <svg aria-label={m.race_result_flag_aria()} className={cn("size-5", className)} viewBox="0 0 24 24" fill="none" role="img">
      <path d="M6 21V4m0 1h11l-2 3 2 3H6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5h2v2H8zm4 0h2v2h-2zM8 9h2v2H8zm4 0h2v2h-2z" fill="currentColor" />
    </svg>
  );
}

function TimelineNode({ node }: { node: RaceResultTimelineNode }) {
  if (node.kind === "qualifying") {
    return (
      <div className="min-w-32 rounded-xl border border-status-info/50 bg-status-info/10 px-4 py-3">
        <div className="text-app-caption font-semibold uppercase tracking-app-label text-status-info">{m.race_result_qualifying()}</div>
        <div className="mt-1 text-sm font-semibold text-app-text">{m.race_result_qualified_position({ position: node.position })}</div>
      </div>
    );
  }

  if (node.kind === "start") {
    return (
      <div className="min-w-32 rounded-xl border border-app-border/80 bg-app-surface px-4 py-3 shadow-sm shadow-app-bg/20">
        <div className="text-app-caption font-semibold uppercase tracking-app-label text-app-text/55">{m.race_result_start()}</div>
        <div className="mt-1 text-sm font-semibold text-app-text">{node.position != null ? m.race_result_grid_position({ position: node.position }) : m.race_result_session_begins()}</div>
      </div>
    );
  }

  if (node.kind === "position") {
    return (
      <div
        className={`min-w-28 rounded-xl border px-4 py-3 shadow-sm shadow-app-bg/20 ${node.direction === "up" ? "border-status-success/50 bg-status-success/10" : "border-status-danger/50 bg-status-danger/10"}`}
      >
        <div className={`text-app-caption font-semibold uppercase tracking-app-label ${node.direction === "up" ? "text-status-success" : "text-status-danger"}`}>{m.race_result_position()}</div>
        {node.lapNumber != null && <div className="mt-1 text-xs text-app-text/65">{m.race_result_end_lap({ lap: node.lapNumber })}</div>}
        <div className="mt-0.5 text-lg font-bold leading-none text-app-text">
          <span className="sr-only">
            {node.direction === "up" ? m.race_result_gained() : m.race_result_lost()}{node.position != null ? ` ${m.race_result_to_position({ position: node.position })}` : ""}
          </span>
          <span aria-hidden="true">
            {node.direction === "up" ? "↑" : "↓"}
            {node.position != null && <span className="ml-1 text-sm">P{node.position}</span>}
          </span>
        </div>
      </div>
    );
  }
  if (node.kind === "penalty") {
    return (
      <div className="min-w-32 rounded-xl border border-status-danger/50 bg-status-danger/10 px-4 py-3">
        <div className="text-app-caption font-semibold uppercase tracking-app-label text-status-danger">{m.race_result_penalty()}</div>
        {node.lapNumber != null && <div className="mt-1 text-xs text-app-text/65">{m.race_result_lap({ lap: node.lapNumber })}</div>}
        <div className="mt-0.5 text-sm font-semibold capitalize text-app-text">{node.penaltyType}</div>
        {node.penaltyTime > 0 && <div className="text-xs text-app-text/70">{m.race_result_penalty_time({ duration: node.penaltyTime.toFixed(1) })}</div>}
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
        {node.classification !== "qualifying" && node.finishingPosition != null && <div className="mt-1 text-xs text-app-text/70">{m.race_result_finish_position({ position: node.finishingPosition })}</div>}
      </div>
    );
  }

  const tyre = tyreChangeLabel(node.tyreChange);
  return (
    <div className="min-w-40 rounded-xl border border-app-accent/50 bg-app-accent/10 px-4 py-3 shadow-sm shadow-app-bg/20">
      <div className="text-app-caption font-semibold uppercase tracking-app-label text-app-accent">{formatService(node.service)}</div>
      {node.lapNumber != null && <div className="mt-1 text-sm font-semibold text-app-text">{m.race_result_lap({ lap: node.lapNumber })}</div>}
      {node.durationSeconds != null && <div className="text-xs text-app-text/70">{m.race_result_stop_duration({ duration: node.durationSeconds.toFixed(1) })}</div>}
      {tyre && <div className="text-xs text-app-text/70">{tyre}</div>}
      {node.fuelAdded != null && <div className="text-xs text-app-text/70">{m.race_result_fuel_added({ fuel: node.fuelAdded.toFixed(1) })}</div>}
    </div>
  );
}

export function RaceResultLedger({ sessionId, gameId, enabled }: { sessionId: number; gameId: GameId; enabled: boolean }) {
  const resultQuery = useSessionResult(sessionId, gameId, enabled);

  if (resultQuery.isLoading) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_loading_timeline()}</div>;
  if (resultQuery.isError) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_timeline_unavailable()}</div>;
  if (!resultQuery.data) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_no_timeline()}</div>;

  const nodes = buildRaceResultTimeline(resultQuery.data);
  return (
    <section aria-label={m.race_result_timeline()} className="border-b border-app-border bg-app-surface-alt/20 px-4 py-4">
      <div className="mb-3 text-app-caption font-semibold uppercase tracking-app-label text-app-text/55">{m.race_result_timeline()}</div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-center">
          {nodes.map((node, index) => (
            <div key={"sequence" in node ? `${node.kind}-${node.sequence}` : node.kind} className="flex items-center">
              <TimelineNode node={node} />
              {index < nodes.length - 1 && <div aria-hidden="true" className="mx-2 h-px w-10 bg-app-border/80" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
