import type { RaceEvent } from "../../shared/racing/events/contracts";
import {
  appendRaceEvents,
  attachRaceEventsToLap,
  finalizeRaceEventSourceGeneration,
  replaceReplayableRaceEvents,
  type ReplaceReplayableRaceEventsInput,
  type ReplaceReplayableRaceEventsResult,
} from "../db/race-event-queries";
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
  refreshQualityLinks(sessionId: number): Promise<void>;
  replace(
    input: ReplaceReplayableRaceEventsInput,
  ): Promise<ReplaceReplayableRaceEventsResult>;
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

  attachLap(sessionId: number, lapNumber: number, lapId: number): Promise<RaceEvent[]> {
    return attachRaceEventsToLap(sessionId, lapNumber, lapId);
  }

  async refreshQualityLinks(sessionId: number): Promise<void> {
    await linkSessionQualityEvents(sessionId);
  }

  replace(
    input: ReplaceReplayableRaceEventsInput,
  ): Promise<ReplaceReplayableRaceEventsResult> {
    return replaceReplayableRaceEvents(input);
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

  replace(input: ReplaceReplayableRaceEventsInput): Promise<ReplaceReplayableRaceEventsResult> {
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
    return this.append(input.events).then(() => ({
      events: this.list().filter((event) => event.sessionId === input.sessionId),
      lapIdsByNumber: new Map<number, number>(),
      conflictCount: 0,
    }));
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
}
