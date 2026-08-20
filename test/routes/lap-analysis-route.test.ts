import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";

import { lapRoutes } from "../../server/routes/laps";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";

initGameAdapters();

test("semantic replay requests lap-relative timing and position", () => {
  expect(semanticReplayIds()).toContain("timing.current-lap");
  expect(semanticReplayIds()).toContain("timing.lap-fraction");
});
test("semantic replay requests every Analyse display dependency", () => {
  const ids = semanticReplayIds();
  for (const id of [
    "brakes.brake-bias",
    "fuel.ers-deployed",
    "fuel.ers-harvested",
    "fuel.capacity",
    "fuel.remaining-fraction",
    "fuel.remaining-percent",
    "fuel.remaining-volume",
    "identity.car-ordinal",
    "motion.pitch",
    "motion.roll",
    "identity.player-track-surface",
    "motion.pitch",
    "motion.roll",
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
