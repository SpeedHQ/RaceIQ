import type { RaceEvent } from "../../shared/racing/events/contracts";
import type {
  SessionRun,
  SessionRunEvidence,
  SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import {
  appendRaceEvents,
  attachRaceEventsToLap,
  finalizeRaceEventSourceGeneration,
  replaceReplayableSessionArtifacts,
  type ReplaceReplayableSessionArtifactsInput,
  type ReplaceReplayableSessionArtifactsResult,
} from "../db/race-event-queries";
import {
  appendRaceEventsWithSessionRunUpdate,
  appendSessionRunArtifacts,
  SessionRunConflictError,
  type AppendedSessionRunArtifacts,
} from "../db/session-run-queries";
import type { PreparedSessionRunUpdate } from "../session-runs/builder";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { RaceEventConflictError, compareRaceEvents } from "./ordering";
export { RaceEventConflictError, compareRaceEvents } from "./ordering";

export interface RaceEventStore {
  append(events: readonly RaceEvent[]): Promise<RaceEvent[]>;
  appendWithLapLinks(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
  ): Promise<RaceEvent[]>;
  attachLap(sessionId: number, lapNumber: number, lapId: number): Promise<RaceEvent[]>;
  appendWithSessionRunUpdate(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<AppendedSessionRunArtifacts>;
  appendSessionRunUpdate(
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<SessionRun[]>;
  refreshQualityLinks(sessionId: number): Promise<void>;
  replace(
    input: ReplaceReplayableSessionArtifactsInput,
  ): Promise<ReplaceReplayableSessionArtifactsResult>;
  finalizeSourceGeneration(
    sessionId: number,
    sourceGeneration: string,
  ): Promise<number>;
}

export interface RaceEventLapLink {
  sessionId: number;
  lapNumber: number;
  lapId: number;
}

/** Production persistence port. Detectors and the coordinator never import DB. */
export class DatabaseRaceEventStore implements RaceEventStore {
  append(events: readonly RaceEvent[]): Promise<RaceEvent[]> {
    return appendRaceEvents(events);
  }

  async appendWithLapLinks(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
  ): Promise<RaceEvent[]> {
    const inserted = await appendRaceEvents(events);
    const linkedById = new Map<string, RaceEvent>();
    for (const link of links) {
      for (const event of await attachRaceEventsToLap(
        link.sessionId,
        link.lapNumber,
        link.lapId,
      )) {
        linkedById.set(event.eventId, event);
      }
    }
    return inserted.map((event) => linkedById.get(event.eventId) ?? event);
  }

  appendWithSessionRunUpdate(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<AppendedSessionRunArtifacts> {
    return appendRaceEventsWithSessionRunUpdate(events, links, update);
  }

  appendSessionRunUpdate(
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<SessionRun[]> {
    return appendSessionRunArtifacts(update);
  }

  attachLap(sessionId: number, lapNumber: number, lapId: number): Promise<RaceEvent[]> {
    return attachRaceEventsToLap(sessionId, lapNumber, lapId);
  }

  async refreshQualityLinks(sessionId: number): Promise<void> {
    await linkSessionQualityEvents(sessionId);
  }

  replace(
    input: ReplaceReplayableSessionArtifactsInput,
  ): Promise<ReplaceReplayableSessionArtifactsResult> {
    return replaceReplayableSessionArtifacts(input);
  }

  finalizeSourceGeneration(
    sessionId: number,
    sourceGeneration: string,
  ): Promise<number> {
    return finalizeRaceEventSourceGeneration(sessionId, sourceGeneration);
  }
}

/** Small deterministic store for detector tests and in-memory rebuild staging. */
export class MemoryRaceEventStore {
  private readonly rows = new Map<string, RaceEvent>();
  private readonly runRows = new Map<string, SessionRun>();
  private readonly membershipRows = new Map<string, SessionRunLapMembership>();
  private readonly evidenceRows = new Map<string, SessionRunEvidence>();

  append(events: readonly RaceEvent[]): Promise<RaceEvent[]> {
    const inserted: RaceEvent[] = [];
    for (const event of events) {
      const previous = this.rows.get(event.eventId);
      if (previous == null) {
        this.rows.set(event.eventId, event);
        inserted.push(event);
      } else if (previous.contentHash !== event.contentHash) {
        throw new RaceEventConflictError(previous, event);
      }
    }
    return Promise.resolve(inserted.sort(compareRaceEvents));
  }

  async appendWithLapLinks(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
  ): Promise<RaceEvent[]> {
    const inserted = await this.append(events);
    for (const link of links) {
      await this.attachLap(link.sessionId, link.lapNumber, link.lapId);
    }
    return inserted
      .map((event) => this.rows.get(event.eventId) ?? event)
      .sort(compareRaceEvents);
  }

  async appendWithSessionRunUpdate(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<AppendedSessionRunArtifacts> {
    const conflicting = update.runs.find((run) => {
      const previous = this.runRows.get(run.runId);
      return previous != null && previous.contentHash !== run.contentHash;
    });
    if (conflicting) throw new SessionRunConflictError(conflicting.runId);
    const appendedEvents = await this.appendWithLapLinks(events, links);
    const appendedRuns = await this.appendSessionRunUpdate(update);
    return { events: appendedEvents, runs: appendedRuns };
  }

  appendSessionRunUpdate(
    update: Pick<PreparedSessionRunUpdate, "runs" | "memberships" | "evidence">,
  ): Promise<SessionRun[]> {
    const inserted: SessionRun[] = [];
    for (const run of update.runs) {
      const previous = this.runRows.get(run.runId);
      if (previous == null) {
        this.runRows.set(run.runId, run);
        inserted.push(run);
      } else if (previous.contentHash !== run.contentHash) {
        throw new SessionRunConflictError(run.runId);
      }
    }
    for (const membership of update.memberships) {
      this.membershipRows.set(
        `${membership.runId}:${membership.lapEventId}`,
        membership,
      );
    }
    for (const item of update.evidence) {
      this.evidenceRows.set(`${item.runId}:${item.eventId}:${item.role}`, item);
    }
    return Promise.resolve(inserted);
  }

  attachLap(sessionId: number, lapNumber: number, lapId: number): Promise<RaceEvent[]> {
    const updated: RaceEvent[] = [];
    for (const [eventId, event] of this.rows) {
      if (event.sessionId !== sessionId || event.lapNumber !== lapNumber) continue;
      const linked = { ...event, lapId } as RaceEvent;
      this.rows.set(eventId, linked);
      updated.push(linked);
    }
    return Promise.resolve(updated.sort(compareRaceEvents));
  }

  refreshQualityLinks(_sessionId: number): Promise<void> {
    return Promise.resolve();
  }

  async replace(
    input: ReplaceReplayableSessionArtifactsInput,
  ): Promise<ReplaceReplayableSessionArtifactsResult> {
    for (const [eventId, event] of this.rows) {
      if (event.sessionId === input.sessionId && ![
        "source_connected",
        "source_disconnected",
        "source_stale",
        "source_recovered",
        "storage_drop",
        "storage_failure",
      ].includes(event.eventType)) {
        this.rows.delete(eventId);
      }
    }
    for (const [runId, run] of this.runRows) {
      if (run.sessionId === input.sessionId) this.runRows.delete(runId);
    }
    for (const [key, membership] of this.membershipRows) {
      if (input.runs.some(({ runId }) => runId === membership.runId)) {
        this.membershipRows.delete(key);
      }
    }
    for (const [key, item] of this.evidenceRows) {
      if (input.runs.some(({ runId }) => runId === item.runId)) {
        this.evidenceRows.delete(key);
      }
    }
    await this.append(input.events);
    const runs = await this.appendSessionRunUpdate(input);
    return {
      events: this.list().filter((event) => event.sessionId === input.sessionId),
      runs,
      memberships: [...input.memberships],
      evidence: [...input.evidence],
      lapIdsByNumber: new Map<number, number>(),
      conflictCount: 0,
    };
  }

  finalizeSourceGeneration(sessionId: number, sourceGeneration: string): Promise<number> {
    let updated = 0;
    for (const [eventId, event] of this.rows) {
      if (
        event.sessionId === sessionId &&
        (event.sourceGeneration == null || event.sourceGeneration.startsWith("provisional:"))
      ) {
        this.rows.set(eventId, { ...event, sourceGeneration } as RaceEvent);
        updated += 1;
      }
    }
    return Promise.resolve(updated);
  }

  list(): RaceEvent[] {
    return [...this.rows.values()].sort(compareRaceEvents);
  }

  listSessionRuns(): SessionRun[] {
    return [...this.runRows.values()].sort(
      (left, right) =>
        left.timelineEpoch - right.timelineEpoch ||
        left.openingSequence - right.openingSequence ||
        left.openingEventOrder - right.openingEventOrder ||
        left.runId.localeCompare(right.runId),
    );
  }

  listSessionRunMemberships(): SessionRunLapMembership[] {
    return [...this.membershipRows.values()].sort(
      (left, right) =>
        left.runId.localeCompare(right.runId) ||
        left.ordinal - right.ordinal ||
        left.lapEventId.localeCompare(right.lapEventId),
    );
  }

  listSessionRunEvidence(): SessionRunEvidence[] {
    return [...this.evidenceRows.values()].sort(
      (left, right) =>
        left.runId.localeCompare(right.runId) ||
        left.eventId.localeCompare(right.eventId) ||
        left.role.localeCompare(right.role),
    );
  }
}
