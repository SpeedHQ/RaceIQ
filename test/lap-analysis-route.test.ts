import { describe, expect, test } from "bun:test";

import { lapRoutes } from "../server/routes/lap-routes";

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
