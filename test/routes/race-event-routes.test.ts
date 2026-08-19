import { describe, expect, test } from "bun:test";

import { RaceEventCursorError, type RaceEventListQuery } from "../../server/db/race-event-queries";
import { createSessionRoutes } from "../../server/routes/session-routes";

describe("session race-event route", () => {
  test("parses intersecting filters and returns the durable page", async () => {
    const receivedSessionIds: number[] = [];
    const receivedQueries: RaceEventListQuery[] = [];
    const page = { items: [], nextCursor: "next-page" };
    const routes = createSessionRoutes({
      sessionExists: async () => true,
      listSessionRaceEvents: async (sessionId, query) => {
        receivedSessionIds.push(sessionId);
        receivedQueries.push(query ?? {});
        return page;
      },
    });

    const response = await routes.request(
      "/api/sessions/42/events?participantId=local-player&lapNumber=4&fromSourceTimeMs=1000&toSourceTimeMs=2500&eventType=pit_entry&lifecycleId=pit-visit%3A42%3A1&qualityOnly=true&cursor=opaque-cursor&limit=17",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(receivedSessionIds).toEqual([42]);
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
      sessionExists: async () => true,
      listSessionRaceEvents: async (_sessionId, query) => {
        receivedQueries.push(query ?? {});
        return { items: [], nextCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events");

    expect(response.status).toBe(200);
    expect(receivedQueries).toEqual([{ limit: 200 }]);
  });

  test("returns 404 without querying events when the session is missing", async () => {
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExists: async () => false,
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/events");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(listCalls).toBe(0);
  });

  test("rejects invalid filters before hitting persistence", async () => {
    let listCalls = 0;
    const routes = createSessionRoutes({
      sessionExists: async () => true,
      listSessionRaceEvents: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null };
      },
    });

    const response = await routes.request(
      "/api/sessions/42/events?fromSourceTimeMs=20&toSourceTimeMs=10&limit=1001",
    );

    expect(response.status).toBe(400);
    expect(listCalls).toBe(0);
  });

  test("returns 400 for an invalid opaque cursor", async () => {
    const routes = createSessionRoutes({
      sessionExists: async () => true,
      listSessionRaceEvents: async () => {
        throw new RaceEventCursorError();
      },
    });

    const response = await routes.request("/api/sessions/42/events?cursor=not-a-cursor");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid race-event cursor" });
  });
});
