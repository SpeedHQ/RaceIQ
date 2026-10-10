import { expect, test } from "bun:test";
import { dashboardRoutes } from "../../src/routes/dashboard-routes";

test("dashboard rejects malformed intervals, removed timezone parameter, and game scope before reads", async () => {
  for (const query of [
    "from=bad&to=2026-01-02T00%3A00%3A00Z",
    "from=2026-01-02T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z",
    "from=2025-01-01T00%3A00%3A00Z&to=2026-01-03T00%3A00%3A00Z",
    "from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z&timeZone=Not%2FAZone",
  ]) {
    const response = await dashboardRoutes.request(`http://localhost/api/dashboard?${query}`);
    expect(response.status).toBe(400);
  }
  const invalidGame = await dashboardRoutes.request(
    "http://localhost/api/dashboard?from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z",
    { headers: { "X-Game-Id": "unsupported" } },
  );
  expect(invalidGame.status).toBe(400);
});

test("dashboard recap rejects malformed identifiers and missing or invalid game header", async () => {
  expect((await dashboardRoutes.request("/api/dashboard/sessions/nope/recap", { headers: { "X-Game-Id": "acc" } })).status).toBe(400);
  expect((await dashboardRoutes.request("/api/dashboard/sessions/1/recap")).status).toBe(400);
  expect((await dashboardRoutes.request("/api/dashboard/sessions/1/recap", { headers: { "X-Game-Id": "invalid" } })).status).toBe(400);
});
