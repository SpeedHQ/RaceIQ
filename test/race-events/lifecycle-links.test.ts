import { describe, expect, test } from "bun:test";

import type { RaceEvent, RaceEventType } from "../../shared/racing/events/contracts";
import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

function eventOf<Type extends RaceEventType>(events: readonly RaceEvent[], eventType: Type): Extract<RaceEvent, { eventType: Type }> {
  const event = events.find((candidate) => candidate.eventType === eventType);
  if (!event) throw new Error(`Missing ${eventType} race event`);
  return event as Extract<RaceEvent, { eventType: Type }>;
}

function cautionEpisode(sessionId: number): {
  started: Extract<RaceEvent, { eventType: "caution_started" }>;
  ended: Extract<RaceEvent, { eventType: "caution_ended" }>;
} {
  const coordinator = new RaceEventCoordinator({ sessionId });
  const opening = coordinator.processObservation(
    sessionId,
    observation(1, {
      gameId: "acc",
      sessionPhase: "caution",
      cautionKind: "local-yellow",
      nativeRaceControlCode: "yellow",
    }),
  );
  const closing = coordinator.processObservation(
    sessionId,
    observation(2, {
      gameId: "acc",
      sessionPhase: "unknown",
      nativeRaceControlCode: "none",
    }),
  );
  return {
    started: eventOf(opening.events, "caution_started"),
    ended: eventOf(closing.events, "caution_ended"),
  };
}

describe("race-event lifecycle links", () => {
  test("replays caution opening identity and close link deterministically", () => {
    const first = cautionEpisode(81);
    const replay = cautionEpisode(81);

    expect(first.started.lifecycleId).not.toBeNull();
    expect(first.ended.lifecycleId).toBe(first.started.lifecycleId);
    expect(first.ended.linkedEventId).toBe(first.started.eventId);
    expect({
      openingEventId: replay.started.eventId,
      closingEventId: replay.ended.eventId,
      lifecycleId: replay.started.lifecycleId,
      linkedEventId: replay.ended.linkedEventId,
    }).toEqual({
      openingEventId: first.started.eventId,
      closingEventId: first.ended.eventId,
      lifecycleId: first.started.lifecycleId,
      linkedEventId: first.ended.linkedEventId,
    });
  });

  test("links damage and penalty clears to participant-scoped openings", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 82 });
    coordinator.processObservation(82, observation(1));
    const openings = coordinator.processObservation(
      82,
      observation(2, {
        participants: [participant({ damage: { body: 5 }, penaltyValue: 1 })],
      }),
    );
    const closings = coordinator.processObservation(
      82,
      observation(3, {
        participants: [participant({ damage: { body: 0 }, penaltyValue: 0 })],
      }),
    );

    const damageStarted = eventOf(openings.events, "damage_warning_started");
    const damageCleared = eventOf(closings.events, "damage_warning_cleared");
    const penaltyIssued = eventOf(openings.events, "penalty_issued");
    const penaltyCleared = eventOf(closings.events, "penalty_cleared");

    expect(damageStarted.lifecycleId).not.toBeNull();
    expect(damageCleared.lifecycleId).toBe(damageStarted.lifecycleId);
    expect(damageCleared.linkedEventId).toBe(damageStarted.eventId);
    expect(penaltyIssued.lifecycleId).not.toBeNull();
    expect(penaltyCleared.lifecycleId).toBe(penaltyIssued.lifecycleId);
    expect(penaltyCleared.linkedEventId).toBe(penaltyIssued.eventId);
    expect(penaltyIssued.lifecycleId).not.toBe(damageStarted.lifecycleId);
  });

  test("keeps stale and connection episodes separate and links proven closes", () => {
    const staleCoordinator = new RaceEventCoordinator({ sessionId: 83 });
    const initial = staleCoordinator.processObservation(83, observation(1));
    const connected = eventOf(initial.events, "source_connected");
    const stale = eventOf(
      staleCoordinator.noteSourceLifecycle({
        kind: "timeout",
        timestampMs: 200,
        eventId: "source-timeout:fixture",
      }),
      "source_stale",
    );
    const recovered = eventOf(
      staleCoordinator.noteSourceLifecycle({
        kind: "reconnect",
        timestampMs: 300,
        eventId: "source-reconnect:fixture",
      }),
      "source_recovered",
    );
    const disconnected = eventOf(
      staleCoordinator.noteSourceLifecycle({
        kind: "stop",
        timestampMs: 400,
        eventId: "source-stop:fixture",
      }),
      "source_disconnected",
    );

    expect(stale.lifecycleId).not.toBeNull();
    expect(recovered.lifecycleId).toBe(stale.lifecycleId);
    expect(recovered.linkedEventId).toBe(stale.eventId);
    expect(connected.lifecycleId).not.toBe(stale.lifecycleId);
    expect(connected.lifecycleId).not.toBeNull();
    expect(disconnected.lifecycleId).toBe(connected.lifecycleId);
    expect(disconnected.linkedEventId).toBe(connected.eventId);
  });

  test("exposes complete pit membership and links later events to pit entry", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 85 });
    coordinator.processObservation(85, observation(1));
    const entry = eventOf(
      coordinator.processObservation(
        85,
        observation(2, {
          participants: [participant({ pitState: "pit-lane" })],
        }),
      ).events,
      "pit_entry",
    );
    coordinator.processObservation(
      85,
      observation(3, {
        participants: [participant({ pitState: "pit-stall", speedMps: 0 })],
      }),
    );
    coordinator.processObservation(
      85,
      observation(4, {
        participants: [participant({ pitState: "pit-lane", speedMps: 5 })],
      }),
    );
    coordinator.processObservation(
      85,
      observation(5, {
        participants: [participant({ pitState: "out" })],
      }),
    );

    const lifecycleId = entry.lifecycleId;
    expect(lifecycleId).not.toBeNull();
    const members = coordinator.events().filter((event) => event.lifecycleId === lifecycleId);
    expect(members.map(({ eventType }) => eventType)).toEqual(["pit_entry", "pit_stall_arrival", "pit_service_started", "pit_service_completed", "pit_stall_departure", "pit_exit"]);
    expect(members.slice(1).every(({ linkedEventId }) => linkedEventId === entry.eventId)).toBe(true);
  });

  test("does not invent opening links for seeded or disappeared participant state", () => {
    const seeded = new RaceEventCoordinator({ sessionId: 86 });
    seeded.processObservation(
      86,
      observation(1, {
        participants: [participant({ damage: { body: 5 }, penaltyValue: 1 })],
      }),
    );
    const unknownClosings = seeded.processObservation(
      86,
      observation(2, {
        participants: [participant({ damage: { body: 0 }, penaltyValue: 0 })],
      }),
    );
    for (const eventType of ["damage_warning_cleared", "penalty_cleared"] as const) {
      const event = eventOf(unknownClosings.events, eventType);
      expect(event.lifecycleId).toBeNull();
      expect(event.linkedEventId).toBeNull();
    }

    const disappeared = new RaceEventCoordinator({ sessionId: 87 });
    disappeared.processObservation(87, observation(1));
    disappeared.processObservation(
      87,
      observation(2, {
        rosterAuthoritative: true,
        participants: [participant({ damage: { body: 5 } })],
      }),
    );
    disappeared.processObservation(87, observation(3, { rosterAuthoritative: true, participants: [] }));
    disappeared.processObservation(87, observation(4, { rosterAuthoritative: true, participants: [] }));
    disappeared.processObservation(
      87,
      observation(5, {
        rosterAuthoritative: true,
        participants: [participant({ damage: { body: 5 } })],
      }),
    );
    const afterReturn = disappeared.processObservation(
      87,
      observation(6, {
        rosterAuthoritative: true,
        participants: [participant({ damage: { body: 0 } })],
      }),
    );
    const cleared = eventOf(afterReturn.events, "damage_warning_cleared");
    expect(cleared.lifecycleId).toBeNull();
    expect(cleared.linkedEventId).toBeNull();
  });
});
