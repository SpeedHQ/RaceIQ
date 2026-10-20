import type { GameId } from "@raceiq/shared/games/ids";
import type { RaceResult } from "@raceiq/shared/racing/results/types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { isPracticeSession } from "@raceiq/shared/racing/sessions/session-type";
import { ArrowDown, ArrowUp } from "lucide-react";
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

export function buildRaceResultTimeline(
  result: RaceResult | null | undefined,
  laps: readonly Pick<LapMeta, "id" | "lapNumber" | "classification">[] = [],
): RaceResultTimelineNode[] {
  const practice = result ? isPracticeSession(result.sessionType) : false;
  const qualifyingPosition = practice ? null : result?.qualifyingPosition ?? null;
  let currentPosition = qualifyingPosition;
  const eventNodes: RaceResultTimelineNode[] = [];
  for (const event of result?.events.slice().sort((a, b) => a.sequence - b.sequence) ?? []) {
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
  const pitLaps = new Set(eventNodes.filter((node) => node.kind === "pit").map((node) => node.lapNumber));
  for (const lap of laps.filter((lap) => lap.classification === "in_lap").sort((a, b) => a.lapNumber - b.lapNumber || a.id - b.id)) {
    if (pitLaps.has(lap.lapNumber)) continue;
    const pit: RaceResultTimelineNode = {
      kind: "pit",
      sequence: -lap.id,
      lapNumber: lap.lapNumber,
      durationSeconds: null,
      service: "unknown",
      tyreChange: null,
      fuelAdded: null,
    };
    const nextEvent = eventNodes.findIndex((node) => "lapNumber" in node && node.lapNumber != null && node.lapNumber >= lap.lapNumber);
    eventNodes.splice(nextEvent === -1 ? eventNodes.length : nextEvent, 0, pit);
    pitLaps.add(lap.lapNumber);
  }
  if (!result && eventNodes.length === 0) return [];
  return [
    ...(qualifyingPosition != null ? [{ kind: "qualifying" as const, position: qualifyingPosition }] : []),
    { kind: "start", position: qualifyingPosition },
    ...eventNodes,
    ...(result ? [{
      kind: "finish" as const,
      classification: result.classification,
      finishingPosition: practice ? null : result.finishingPosition,
    }] : []),
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
  const circleClassName = "flex size-16 shrink-0 items-center justify-center gap-1 rounded-full border text-app-compact font-semibold";

  if (node.kind === "qualifying" || node.kind === "start") {
    const qualifying = node.kind === "qualifying";
    const label = qualifying ? m.race_result_qualified() : m.race_result_start();
    const detail = node.position != null
      ? qualifying ? m.race_result_qualified_position({ position: node.position }) : m.race_result_grid_position({ position: node.position })
      : m.race_result_session_begins();
    return (
      <div
        role="img"
        className={cn(circleClassName, qualifying ? "border-status-info/50 bg-status-info/10 text-status-info" : "border-app-border bg-app-surface text-app-text")}
        title={`${label}: ${detail}`}
        aria-label={`${label}: ${detail}`}
      >
        <span className="flex flex-col items-center gap-0.5">
          <span>{label}</span>
          {node.position != null && <span className="font-mono text-app-detail tabular-nums">P{node.position}</span>}
        </span>
      </div>
    );
  }

  if (node.kind === "position") {
    const gained = node.direction === "up";
    const Arrow = gained ? ArrowUp : ArrowDown;
    const detail = [
      gained ? m.race_result_gained() : m.race_result_lost(),
      node.position != null ? m.race_result_to_position({ position: node.position }) : null,
      node.lapNumber != null ? m.race_result_end_lap({ lap: node.lapNumber }) : null,
    ].filter(Boolean).join(" · ");
    return (
      <div
        role="img"
        className={cn(circleClassName, gained ? "border-status-success/50 bg-status-success/10 text-status-success" : "border-status-danger/50 bg-status-danger/10 text-status-danger")}
        title={detail}
        aria-label={detail}
      >
        <Arrow aria-hidden="true" className="size-4" />
        <span aria-hidden="true" className="font-mono text-app-detail tabular-nums">{node.position}</span>
      </div>
    );
  }

  if (node.kind === "penalty") {
    const detail = [
      m.race_result_penalty(),
      node.lapNumber != null ? m.race_result_lap({ lap: node.lapNumber }) : null,
      node.penaltyType,
      node.penaltyTime > 0 ? m.race_result_penalty_time({ duration: node.penaltyTime.toFixed(1) }) : null,
    ].filter(Boolean).join(" · ");
    return (
      <div role="img" className={cn(circleClassName, "border-status-danger/50 bg-status-danger/10 text-status-danger")} title={detail} aria-label={detail}>
        {m.race_result_penalty()}
      </div>
    );
  }

  if (node.kind === "finish") {
    const presentation = RESULT_PRESENTATION[node.classification];
    const detail = node.classification !== "qualifying" && node.finishingPosition != null
      ? `${presentation.label} · ${m.race_result_finish_position({ position: node.finishingPosition })}`
      : presentation.label;
    return (
      <div role="img" className={cn(circleClassName, presentation.surfaceClassName, presentation.accentClassName)} title={detail} aria-label={detail}>
        <span aria-hidden="true"><ResultFlag className={presentation.accentClassName} /></span>
        {node.classification !== "qualifying" && node.finishingPosition != null && <span aria-hidden="true" className="font-mono tabular-nums">{node.finishingPosition}</span>}
      </div>
    );
  }

  const detail = [
    formatService(node.service),
    node.lapNumber != null ? m.race_result_lap({ lap: node.lapNumber }) : null,
    node.durationSeconds != null ? m.race_result_stop_duration({ duration: node.durationSeconds.toFixed(1) }) : null,
    tyreChangeLabel(node.tyreChange),
    node.fuelAdded != null ? m.race_result_fuel_added({ fuel: node.fuelAdded.toFixed(1) }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <div role="img" className={cn(circleClassName, "border-app-accent/50 bg-app-accent/10 text-app-accent")} title={detail} aria-label={detail}>
      {m.race_result_pit()}
    </div>
  );
}

export function RaceResultLedger({ sessionId, gameId, enabled, laps }: { sessionId: number; gameId: GameId; enabled: boolean; laps: readonly LapMeta[] }) {
  const resultQuery = useSessionResult(sessionId, gameId, enabled);
  const nodes = buildRaceResultTimeline(resultQuery.data, laps);

  if (nodes.length === 0) {
    if (resultQuery.isLoading) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_loading_timeline()}</div>;
    if (resultQuery.isError) return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_timeline_unavailable()}</div>;
    return <div className="border-b border-app-border px-4 py-3 text-xs text-app-text/60">{m.race_result_no_timeline()}</div>;
  }
  return (
    <section aria-label={m.race_result_timeline()} className="border-b border-app-border bg-app-surface-alt/20 px-4 py-4">
      <div className="mb-3 text-app-caption font-semibold uppercase tracking-app-label text-app-text/55">{m.race_result_timeline()}</div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-center">
          {nodes.map((node, index) => (
            <div key={"sequence" in node ? `${node.kind}-${node.sequence}` : node.kind} className="flex items-center">
              <TimelineNode node={node} />
              {index < nodes.length - 1 && <div aria-hidden="true" className="h-px w-6 bg-app-border/80" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
