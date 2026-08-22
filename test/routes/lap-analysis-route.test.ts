import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";

import { lapRoutes } from "../../server/routes/laps";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";

initGameAdapters();

test("semantic replay requests lap-relative timing", () => {
  expect(semanticReplayIds()).toContain("timing.current-lap");
});
test("semantic replay requests every Analyse Data panel dependency", () => {
  const ids = semanticReplayIds();
  for (const id of [
    "brakes.brake-bias",
    "fuel.ers-deployed",
    "fuel.ers-harvested",
    "fuel.fuel-capacity",
    "identity.car-ordinal",
    "identity.player-track-surface",
    "tires.wheel-in-puddle-depth",
    "suspension.norm-suspension-travel",
    "tires.normalized-tire-slip-angle",
    "tires.tire-radius",
    "tires.wheel-on-rumble-strip",
  ]) {
    expect(ids).toContain(id);
  }
});

describe("POST /api/laps/:id/analyse", () => {
  test("keeps missing-lap HTTP error before regenerate stream", async () => {
    const response = await lapRoutes.request("/api/laps/999999/analyse?regenerate=true", { method: "POST" });

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
  test("requires game identity for comparison status", async () => {
    const response = await lapRoutes.request("/api/laps/1/compare/2/inputs-analyse/status");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });
  });
});

describe("quality-scoped chat history", () => {
  test("requires game identity before loading lap chat history", async () => {
    const response = await lapRoutes.request("/api/laps/999999/chat");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });
  });

  test("requires game identity for comparison chat history", async () => {
    const response = await lapRoutes.request("/api/laps/999998/compare/999999/chat");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing or invalid X-Game-Id header" });
  });
});

describe("comparison chat generation query", () => {
  test("rejects unsafe generation numbers before loading comparison data", async () => {
    const response = await lapRoutes.request("/api/laps/1/compare/2/chat?gen=9007199254740992", {
      headers: { "X-Game-Id": "fm-2023" },
    });

    expect(response.status).toBe(400);
  });
});
