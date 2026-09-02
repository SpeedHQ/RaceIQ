import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import { analyseSemanticIds } from "../../shared/games/metric-contracts";

import { lapRoutes } from "../../server/routes/laps";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";

initGameAdapters();

test("semantic replay requests F1 Analyse dependencies", () => {
  const ids = semanticReplayIds("f1-2025");
  expect(ids).toEqual(analyseSemanticIds(getGame("f1-2025")));
  expect(ids).toContain("timing.current-lap");
  expect(ids).toContain("timing.lap-fraction");
  expect(ids).not.toContain("tires.wheel-in-puddle-depth");
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
