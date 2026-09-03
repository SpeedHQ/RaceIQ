import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import { analyseSemanticIds } from "../../shared/games/metric-contracts";

import { deleteSession, insertSession } from "../../server/db/session-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { cacheDelete, cacheSet } from "../../server/db/telemetry-replay-storage";
import { lapRoutes } from "../../server/routes/laps";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";
import { packet } from "../support/telemetry/resolver";

initGameAdapters();

test("semantic replay requests F1 Analyse dependencies", () => {
  const ids = semanticReplayIds("f1-2025");
  expect(ids).toEqual(analyseSemanticIds(getGame("f1-2025")));
  expect(ids).toContain("timing.current-lap");
  expect(ids).toContain("timing.lap-fraction");
  expect(ids).not.toContain("tires.wheel-in-puddle-depth");
});

describe("GET /api/laps/:id/semantic-telemetry", () => {
  test("returns full F1 Analyse replay with adapter channels", async () => {
    const sessionId = await insertSession(1, 2, "f1-2025");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0);
    cacheSet(lapId, [
      packet("f1-2025", { TimestampMS: 1_000, Speed: 10 }),
      packet("f1-2025", { TimestampMS: 1_017, Speed: 20 }),
    ]);
    try {
      const response = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: readonly string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(body.requestedSemanticIds).toEqual(analyseSemanticIds(getGame("f1-2025")));
      expect(body.envelopes).toHaveLength(2);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
      expect(body.envelopes[0]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 10 })]),
      );
      expect(body.envelopes[1]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 20 })]),
      );
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
});

describe("POST /api/laps/:id/analyse", () => {
  test("keeps missing-lap HTTP error before regenerate stream", async () => {
    const response = await lapRoutes.request(
      "/api/laps/999999/analyse?regenerate=true",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lap not found" });
  });
});

describe("DELETE /api/laps/:id/analyse", () => {
  test("clears only the lap analysis record", async () => {
    const response = await lapRoutes.request("/api/laps/999999/analyse", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("GET /api/laps/:id/analyse/status", () => {
  test("reports no active run for idle lap", async () => {
    const response = await lapRoutes.request("/api/laps/999999/analyse/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none" });
  });
});

describe("GET /api/laps/:id1/compare/:id2/inputs-analyse/status", () => {
  test("reports no active run for idle comparison", async () => {
    const response = await lapRoutes.request(
      "/api/laps/1/compare/2/inputs-analyse/status",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none" });
  });
});
