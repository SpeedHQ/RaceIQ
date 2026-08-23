import { describe, expect, test } from "bun:test";
import type { SessionRunId } from "../../shared/racing/runs/contracts";

import {
  SessionRunCursorError,
  SessionRunNotFoundError,
  type SessionRunListQuery,
} from "../../server/db/session-run-queries";
import { createSessionRoutes } from "../../server/routes/session-routes";

const runId = `session-run:sha256:${"a".repeat(64)}` as SessionRunId;

describe("session run routes", () => {
  test("parses intersecting session filters and default pagination", async () => {
    const queries: SessionRunListQuery[] = [];
    const routes = createSessionRoutes({
      sessionExistsForGame: async () => true,
      listSessionRuns: async (_sessionId, query) => {
        queries.push(query ?? {});
        return { items: [], nextCursor: null };
      },
    });
    const response = await routes.request(
      `/api/sessions/42/runs?runKind=pace&participantId=car-1&driverId=driver-1&observedPhase=caution&timelineEpoch=2&status=incomplete&overlapsRunId=${encodeURIComponent(runId)}&minCompletedLaps=2&maxCompletedLaps=9&qualityOnly=true&gameId=acc`,
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([
      {
        runKind: "pace",
        participantId: "car-1",
        driverId: "driver-1",
        observedPhase: "caution",
        timelineEpoch: 2,
        status: "incomplete",
        overlapsRunId: runId,
        minCompletedLaps: 2,
        maxCompletedLaps: 9,
        qualityOnly: true,
        limit: 200,
      },
    ]);
  });

  test("requires game scope before listing session runs", async () => {
    let calls = 0;
    const routes = createSessionRoutes({
      listSessionRuns: async () => {
        calls += 1;
        return { items: [], nextCursor: null };
      },
    });

    const response = await routes.request("/api/sessions/42/runs");

    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("returns 404 before querying missing sessions and overlap relations", async () => {
    let calls = 0;
    const missingSession = createSessionRoutes({
      sessionExistsForGame: async () => false,
      listSessionRuns: async () => {
        calls += 1;
        return { items: [], nextCursor: null };
      },
    });
    const missingResponse = await missingSession.request(
      "/api/sessions/42/runs?gameId=acc",
    );
    expect(missingResponse.status).toBe(404);
    expect(calls).toBe(0);

    const missingOverlap = createSessionRoutes({
      sessionExistsForGame: async () => true,
      listSessionRuns: async () => {
        throw new SessionRunNotFoundError();
      },
    });
    const overlapResponse = await missingOverlap.request(
      `/api/sessions/42/runs?overlapsRunId=${encodeURIComponent(runId)}&gameId=acc`,
    );
    expect(overlapResponse.status).toBe(404);

    const missingDriverOverlap = createSessionRoutes({
      listDriverStints: async () => {
        throw new SessionRunNotFoundError();
      },
    });
    expect(
      (
        await missingDriverOverlap.request(
          `/api/drivers/driver-1/stints?overlapsRunId=${encodeURIComponent(runId)}`,
        )
      ).status,
    ).toBe(404);
  });

  test("validates branded run and nonempty driver params", async () => {
    const routes = createSessionRoutes();
    expect(
      (await routes.request("/api/session-runs/not-a-run/laps")).status,
    ).toBe(400);
    expect((await routes.request("/api/drivers/%20/stints")).status).toBe(200);
  });

  test("maps cursor failures to 400 on all typed detail surfaces", async () => {
    const routes = createSessionRoutes({
      listSessionRunLaps: async () => {
        throw new SessionRunCursorError();
      },
      listSessionRunEvidence: async () => {
        throw new SessionRunCursorError();
      },
      listComparableSessionRuns: async () => {
        throw new SessionRunCursorError();
      },
    });
    for (const suffix of ["laps", "evidence", "comparable"]) {
      const response = await routes.request(
        `/api/session-runs/${runId}/${suffix}?cursor=bad`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid session-run cursor",
      });
    }
  });

  test("routes driver and run detail queries through typed dependencies", async () => {
    const calls: string[] = [];
    const routes = createSessionRoutes({
      listDriverStints: async (driverId) => {
        calls.push(`driver:${driverId}`);
        return { items: [], nextCursor: null };
      },
      listSessionRunLaps: async (id) => {
        calls.push(`laps:${id}`);
        return { items: [], nextCursor: null };
      },
      listSessionRunEvidence: async (id) => {
        calls.push(`evidence:${id}`);
        return { items: [], nextCursor: null };
      },
      listComparableSessionRuns: async (id) => {
        calls.push(`comparable:${id}`);
        return { items: [], nextCursor: null };
      },
    });
    expect((await routes.request("/api/drivers/driver-1/stints")).status).toBe(
      200,
    );
    for (const suffix of ["laps", "evidence", "comparable"]) {
      expect(
        (await routes.request(`/api/session-runs/${runId}/${suffix}`)).status,
      ).toBe(200);
    }
    expect(calls).toEqual([
      "driver:driver-1",
      `laps:${runId}`,
      `evidence:${runId}`,
      `comparable:${runId}`,
    ]);
  });
});
