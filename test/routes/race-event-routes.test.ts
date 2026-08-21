import { describe, expect, test } from "bun:test";

import { RaceEventCursorError, type RaceEventListQuery } from "../../server/db/race-event-queries";
import { createSessionRoutes } from "../../server/routes/session-routes";

describe("session race-event route", () => {
  test("parses intersecting filters and returns the durable page", async () => {
    const receivedSessionIds: number[] = [];
    const receivedOwnershipChecks: Array<[number, string]> = [];
    const receivedQueries: RaceEventListQuery[] = [];
    const page = { items: [], nextCursor: "next-page", tailCursor: "tail-page" };
    const routes = createSessionRoutes({
      sessionExistsForGame: async (sessionId, gameId) => {
        receivedOwnershipChecks.push([sessionId, gameId]);
        return true;
      },
      listSessionRaceEvents: async (sessionId, query) => {
        receivedSessionIds.push(sessionId);
        receivedQueries.push(query ?? {});
        return page;
      },
    });

    const response = await routes.request(
      "/api/sessions/42/events?gameId=acc&participantId=local-player&lapNumber=4&fromSourceTimeMs=1000&toSourceTimeMs=2500&eventType=pit_entry&lifecycleId=pit-visit%3A42%3A1&qualityOnly=true&cursor=opaque-cursor&limit=17",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(receivedSessionIds).toEqual([42]);
    expect(receivedOwnershipChecks).toEqual([[42, "acc"]]);
    expect(receivedQueries).toEqual([{
      participantId: "local-player",
      lapNumber: 4,
      fromSourceTimeMs: 1_000,
      toSourceTimeMs: 2_500,
      eventType: "pit_entry",
      lifecycleId: "pit-visit:42:1",
      qualityOnly: true,
      cursor: "opaque-cursor",
      limit: 17,
    }]);
  });

  test("applies the contract page-size default", async () => {
    const receivedQueries: RaceEventListQuery[] = [];
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => true,
      listSessionRaceEvents: async (_sessionId, query) => {
        receivedQueries.push(query ?? {});
        return { items: [], nextCursor: null, tailCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events?gameId=acc");

    expect(response.status).toBe(200);
    expect(receivedQueries).toEqual([{ limit: 200 }]);
  });

  test("requires gameId before ownership or persistence checks", async () => {
    let ownershipChecks = 0;
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => {
        ownershipChecks += 1;
        return true;
      },
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null, tailCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events");

    expect(response.status).toBe(400);
    expect(ownershipChecks).toBe(0);
    expect(listCalls).toBe(0);
  });

  test("returns 404 without querying events when the session is missing", async () => {
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => false,
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null, tailCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events?gameId=acc");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(listCalls).toBe(0);
  });

  test("rejects invalid filters before hitting persistence", async () => {
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => true,
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null, tailCursor: null };
      },
    });

    const response = await routes.request(
      "/api/sessions/42/events?gameId=acc&fromSourceTimeMs=20&toSourceTimeMs=10&limit=1001",
    );

    expect(response.status).toBe(400);
    expect(listCalls).toBe(0);
  });

  test("returns 400 for an invalid opaque cursor", async () => {
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => true,
      listSessionRaceEvents: async () => {
        throw new RaceEventCursorError();
      },
    });

    const response = await routes.request("/api/sessions/42/events?gameId=acc&cursor=not-a-cursor");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid race-event cursor" });
  });

  test("rejects a session from another game before querying events", async () => {
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExistsForGame: async (sessionId, gameId) => sessionId === 42 && gameId === "iracing",
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null, tailCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events?gameId=acc");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(listCalls).toBe(0);
  });
});
