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
