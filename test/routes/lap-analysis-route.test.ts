import { afterEach, describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";

import { lapRoutes } from "../../server/routes/laps";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";

initGameAdapters();

const sessionIds: number[] = [];

async function seedLapWithoutTelemetry(lapNumber: number): Promise<number> {
  const session = await db
    .insert(sessions)
    .values({
      carOrdinal: 900_000 + lapNumber,
      trackOrdinal: 901_000,
      gameId: "fm-2023",
    })
    .returning({ id: sessions.id })
    .get();
  sessionIds.push(session.id);
  return (
    await db
      .insert(laps)
      .values({
        sessionId: session.id,
        lapNumber,
        lapTime: 90,
        isValid: true,
      })
      .returning({ id: laps.id })
      .get()
  ).id;
}

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
});

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
    "fuel.fuel-capacity",
    "identity.car-ordinal",
    "motion.pitch",
    "motion.roll",
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

describe("POST /api/laps/:id/experiment-excluded", () => {
  test("accepts required experiment identity before querying the lap", async () => {
    const response = await lapRoutes.request(
      "/api/laps/999999/experiment-excluded",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ experimentId: 123, excluded: true }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lap not found" });
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

describe("cache-only analysis probes", () => {
  test("returns an empty lap cache without treating missing evidence as an HTTP error", async () => {
    const lapId = await seedLapWithoutTelemetry(1);
    const response = await lapRoutes.request(
      `/api/laps/${lapId}/analyse?cacheOnly=true`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis: null, cached: false });
  });

  test("returns an empty comparison cache without treating missing evidence as an HTTP error", async () => {
    const lapAId = await seedLapWithoutTelemetry(2);
    const lapBId = await seedLapWithoutTelemetry(3);
    const response = await lapRoutes.request(
      `/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse?cacheOnly=true`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis: null, cached: false });
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
