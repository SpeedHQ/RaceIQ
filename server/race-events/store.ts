import type { RaceEvent } from "../../shared/racing/events/contracts";
import type {
  SessionRun,
  SessionRunEvidence,
  SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import {
  appendRaceEvents,
  appendRaceEventsWithLapLinks,
  attachRaceEventsToLap,
  finalizeRaceEventSourceGeneration,
  replaceReplayableSessionArtifacts,
  type RaceEventLapLink,
  type ReplaceReplayableSessionArtifactsInput,
  type ReplaceReplayableSessionArtifactsResult,
} from "../db/race-event-queries";
export type { RaceEventLapLink } from "../db/race-event-queries";
import {
  appendRaceEventsWithSessionRunUpdate,
  appendSessionRunArtifacts,
  rebuildPersistedSessionRuns,
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
  refreshSessionRuns(sessionId: number): Promise<SessionRun[]>;
  replace(
    input: ReplaceReplayableSessionArtifactsInput,
  ): Promise<ReplaceReplayableSessionArtifactsResult>;
  finalizeSourceGeneration(
    sessionId: number,
    sourceGeneration: string,
  ): Promise<number>;
}

/** Production persistence port. Detectors and the coordinator never import DB. */
export class DatabaseRaceEventStore implements RaceEventStore {
  append(events: readonly RaceEvent[]): Promise<RaceEvent[]> {
    return appendRaceEvents(events);
  }

  appendWithLapLinks(
    events: readonly RaceEvent[],
    links: readonly RaceEventLapLink[],
  ): Promise<RaceEvent[]> {
    return appendRaceEventsWithLapLinks(events, links);
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

  refreshSessionRuns(sessionId: number): Promise<SessionRun[]> {
    return rebuildPersistedSessionRuns(sessionId);
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
    for (const event of events) {
      const previous = this.rows.get(event.eventId);
      if (previous && previous.contentHash !== event.contentHash) {
        throw new RaceEventConflictError(previous, event);
      }
    }
    const inserted: RaceEvent[] = [];
    for (const event of events) {
      if (this.rows.has(event.eventId)) continue;
      this.rows.set(event.eventId, event);
      inserted.push(event);
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
    for (const run of update.runs) {
      const previous = this.runRows.get(run.runId);
      if (previous && previous.contentHash !== run.contentHash) {
        throw new SessionRunConflictError(run.runId);
      }
    }
    const inserted: SessionRun[] = [];
    for (const run of update.runs) {
      if (this.runRows.has(run.runId)) continue;
      this.runRows.set(run.runId, run);
      inserted.push(run);
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
    const eventSnapshot = new Map(this.rows);
    const runSnapshot = new Map(this.runRows);
    const membershipSnapshot = new Map(this.membershipRows);
    const evidenceSnapshot = new Map(this.evidenceRows);
    try {
      for (const [eventId, event] of this.rows) {
        if (
          event.sessionId === input.sessionId &&
          ![
            "source_connected",
            "source_disconnected",
            "source_stale",
            "source_recovered",
            "storage_drop",
            "storage_failure",
          ].includes(event.eventType)
        ) {
          this.rows.delete(eventId);
        }
      }
      const removedRunIds = new Set<string>();
      for (const [runId, run] of this.runRows) {
        if (run.sessionId !== input.sessionId) continue;
        removedRunIds.add(runId);
        this.runRows.delete(runId);
      }
      for (const [key, membership] of this.membershipRows) {
        if (removedRunIds.has(membership.runId)) {
          this.membershipRows.delete(key);
        }
      }
      for (const [key, item] of this.evidenceRows) {
        if (removedRunIds.has(item.runId)) {
          this.evidenceRows.delete(key);
        }
      }
      await this.append(input.events);
      const runs = await this.appendSessionRunUpdate(input);
      return {
        events: this.list().filter(
          (event) => event.sessionId === input.sessionId,
        ),
        runs,
        memberships: [...input.memberships],
        evidence: [...input.evidence],
        lapIdsByNumber: new Map<number, number>(),
        conflictCount: 0,
      };
    } catch (error) {
      this.rows.clear();
      this.runRows.clear();
      this.membershipRows.clear();
      this.evidenceRows.clear();
      for (const [key, value] of eventSnapshot) this.rows.set(key, value);
      for (const [key, value] of runSnapshot) this.runRows.set(key, value);
      for (const [key, value] of membershipSnapshot) {
        this.membershipRows.set(key, value);
      }
      for (const [key, value] of evidenceSnapshot) {
        this.evidenceRows.set(key, value);
      }
      throw error;
    }
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
    for (const [runId, run] of this.runRows) {
      if (
        run.sessionId === sessionId &&
        (run.sourceGeneration == null ||
          run.sourceGeneration.startsWith("provisional:"))
      ) {
        this.runRows.set(runId, { ...run, sourceGeneration });
      }
    }
    return Promise.resolve(updated);
  }

  refreshSessionRuns(sessionId: number): Promise<SessionRun[]> {
    return Promise.resolve(
      this.listSessionRuns().filter((run) => run.sessionId === sessionId),
    );
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
