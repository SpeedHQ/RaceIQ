import type { RaceEvent } from "../../shared/racing/events/contracts";

export class RaceEventConflictError extends Error {
  readonly existing: RaceEvent;
  readonly incoming: RaceEvent;

  constructor(existing: RaceEvent, incoming: RaceEvent) {
    super(`Race event ${incoming.eventId} conflicts with existing semantic content`);
    this.name = "RaceEventConflictError";
    this.existing = existing;
    this.incoming = incoming;
  }
}

export function compareRaceEvents(left: RaceEvent, right: RaceEvent): number {
  return (
    left.timelineEpoch - right.timelineEpoch ||
    left.sequence - right.sequence ||
    left.eventOrder - right.eventOrder ||
    left.eventId.localeCompare(right.eventId)
  );
}
