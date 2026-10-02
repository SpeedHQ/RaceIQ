import { afterEach, describe, expect, test } from "bun:test";
import { tuneCatalogRoutes } from "../../server/routes/tune-catalog-routes";

const realFetch = globalThis.fetch;

function laptime(track = "Spa") {
  return { track, carClass: "GT3", car: "Car", driver: "Driver", laptime: "1:30.000" };
}

function stubFetch(body: unknown, onFetch?: () => void) {
  globalThis.fetch = (async () => {
    onFetch?.();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        version: "lazy-test-v1",
        laptimes: {
          forza: { path: "forza.json" },
          acc: { path: "acc.json" },
          "ac-evo": { path: "ac-evo.json" },
        },
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("lazy community laptimes", () => {
  test("does not sync when game context is absent", async () => {
    let fetches = 0;
    stubFetch({}, () => { fetches++; });

    const response = await tuneCatalogRoutes.request("/api/laptimes");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(fetches).toBe(0);
  });

  test("concurrent first game-scoped requests share one sync", async () => {
    let manifestFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      manifestFetches += url.endsWith("manifest.json") ? 1 : 0;
      const body = url.endsWith("manifest.json")
        ? {
            version: `lazy-test-${Date.now()}`,
            laptimes: {
              forza: { path: "forza.json" },
              acc: { path: "acc.json" },
              "ac-evo": { path: "ac-evo.json" },
            },
          }
        : [laptime()];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([
      tuneCatalogRoutes.request("/api/laptimes", {
        headers: { "X-Game-Id": "fm-2023" },
      }),
      tuneCatalogRoutes.request("/api/laptimes", {
        headers: { "X-Game-Id": "fm-2023" },
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual([laptime()]);
    expect(await second.json()).toEqual([laptime()]);
    expect(manifestFetches).toBe(1);
  });
});
