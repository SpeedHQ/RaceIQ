import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { Hono } from "hono";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import { LMULiveDashboard } from "../src/components/lmu/LMULiveDashboard";
import { TrackDetail } from "../src/components/track/TrackDetail";
import { useCarName } from "../src/hooks/catalog-queries";
import { useTrackBoundaries, useTrackName, useTrackOutline, useTrackSectorBoundaries, useTrackSectors } from "../src/hooks/track-queries";
import { buildLiveTelemetryView } from "../src/lib/live-telemetry-view";
import { fakeAccSemanticFixture } from "../src/stories/fakeData";
import * as game from "../src/stores/game";
import { telemetryStore } from "../src/stores/telemetry";

initGameAdapters({ lmuAdapter: true });

async function withIdentityRoutes(
  trackId: number | string,
  carId: number | string,
  run: (context: { queries: QueryClient; urls: URL[]; render: (element: ReactElement) => string }) => Promise<void>,
) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const urls: URL[] = [];
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const app = new Hono()
    .get("/api/tracks/:trackOrdinal/all-laps", (c) => c.req.param("trackOrdinal") === String(trackId) ? c.json([]) : c.notFound())
    .get("/api/:resource/:ordinal", (c) => {
      const resource = c.req.param("resource");
      const expected = resource === "car-name" ? carId : trackId;
      if (c.req.param("ordinal") !== String(expected)) return c.notFound();
      if (resource === "car-name") return c.text("Ferrari 499P 2023");
      if (resource === "track-name") return c.text("Circuit de Spa-Francorchamps");
      if (resource === "track-sector-boundaries") return c.json({ s1End: 0.3, s2End: 0.7 });
      if (resource === "track-sectors") return c.json({ segments: [], totalDist: 7004 });
      if (resource === "track-outline") return c.json({ points: [{ x: 1, z: 2 }, { x: 3, z: 4 }] });
      if (resource === "track-boundaries") return c.json({ leftEdge: [], rightEdge: [], pitLane: null, coordSystem: "lmu" });
      return c.notFound();
    });
  const gameId = spyOn(game, "useGameId").mockReturnValue("lmu");
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    urls.push(url);
    return app.fetch(new Request(url, init));
  });
  const render = (element: ReactElement) => renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queries },
    createElement(RouterContextProvider, { router, children: element }),
  ));
  try {
    await run({ queries, urls, render });
  } finally {
    fetch.mockRestore();
    gameId.mockRestore();
    queries.clear();
  }
}

function IdentityQueries({ trackId, carId }: { trackId: number | string; carId: number | string }) {
  useTrackName(trackId);
  useCarName(carId);
  useTrackSectors(trackId);
  useTrackSectorBoundaries(trackId);
  useTrackOutline(trackId);
  useTrackBoundaries(trackId);
  return null;
}

describe("LMU Hono identity requests", () => {
  test("routes slash-containing layouts and exact native car keys as single path parameters", async () => {
    const trackId = "spa_2023/spawec";
    const carId = "Custom / Car %2F #7?";
    await withIdentityRoutes(trackId, carId, async ({ queries, urls, render }) => {
      render(createElement(IdentityQueries, { trackId, carId }));
      const results = await Promise.all(queries.getQueryCache().getAll().map((query) => query.fetch()));
      expect(results).toContain("Circuit de Spa-Francorchamps");
      expect(results).toContain("Ferrari 499P 2023");
      expect(urls.map((url) => url.pathname).sort()).toEqual([
        `/api/car-name/${encodeURIComponent(carId)}`,
        `/api/track-name/${encodeURIComponent(trackId)}`,
        `/api/track-sectors/${encodeURIComponent(trackId)}`,
        `/api/track-sector-boundaries/${encodeURIComponent(trackId)}`,
        `/api/track-outline/${encodeURIComponent(trackId)}`,
        `/api/track-boundaries/${encodeURIComponent(trackId)}`,
      ].sort());
      expect(urls.every((url) => url.searchParams.get("gameId") === "lmu")).toBe(true);
    });
  });

  test("keeps legacy numeric route parameters unchanged", async () => {
    await withIdentityRoutes(7, 42, async ({ queries, urls, render }) => {
      render(createElement(IdentityQueries, { trackId: 7, carId: 42 }));
      const results = await Promise.all(queries.getQueryCache().getAll().map((query) => query.fetch()));
      expect(results).toContain("Circuit de Spa-Francorchamps");
      expect(results).toContain("Ferrari 499P 2023");
      expect(urls.find((url) => url.pathname.startsWith("/api/car-name/"))?.pathname).toBe("/api/car-name/42");
      expect(urls.find((url) => url.pathname.startsWith("/api/track-name/"))?.pathname).toBe("/api/track-name/7");
    });
  });

  test("routes direct TrackDetail map and lap requests using the full layout ID", async () => {
    const trackId = "spa_2023/spawec";
    await withIdentityRoutes(trackId, "ferrari_499p_2023", async ({ queries, urls, render }) => {
      render(createElement(TrackDetail, {
        track: { id: trackId, ordinal: -1, name: "Spa", location: "Spa", country: "BE", variant: "WEC", lengthKm: 7.004, hasOutline: true, createdAt: null },
        onBack: () => {}, tab: "laps", onTabChange: () => {},
      }));
      const directQueries = queries.getQueryCache().getAll().filter((query) => query.queryKey[0] === "track-map" || query.queryKey[0] === "track-laps");
      expect(directQueries.length).toBe(2);
      await Promise.all(directQueries.map((query) => query.fetch()));
      expect(urls.map((url) => url.pathname).sort()).toEqual([
        "/api/track-outline/spa_2023%2Fspawec",
        "/api/track-sectors/spa_2023%2Fspawec",
        "/api/track-sector-boundaries/spa_2023%2Fspawec",
        "/api/tracks/spa_2023%2Fspawec/all-laps",
      ].sort());
    });
  });

  test("renders LMU live header names from semantic string IDs instead of sentinel ordinals", async () => {
    const trackId = "spa_2023/spawec";
    const carId = "ferrari_499p_2023";
    const schema = {
      ...fakeAccSemanticFixture.schema,
      simulator: "lmu" as const,
      definitions: ["identity.car-id", "identity.track-id", "identity.car-ordinal", "identity.track-ordinal"].map((semanticId) => ({ semanticId, unit: null, mappingStatus: "direct" as const, schemaVersion: "1", limitations: [] })),
    };
    const frame = { ...fakeAccSemanticFixture.frame, schemaId: schema.schemaId, values: [carId, trackId, -1, -1], states: undefined, freshness: undefined };
    const view = buildLiveTelemetryView(schema, frame)!;
    const previousTelemetry = telemetryStore.get();
    telemetryStore.setState((state) => ({ ...state, telemetryView: view, sessionLaps: [] }));
    try {
      await withIdentityRoutes(trackId, carId, async ({ queries, urls, render }) => {
        render(createElement(LMULiveDashboard));
        const names = queries.getQueryCache().getAll().filter((query) => query.queryKey[0] === "track-name" || query.queryKey[0] === "car-name");
        await Promise.all(names.map((query) => query.fetch()));
        const markup = render(createElement(LMULiveDashboard));
        expect(markup).toContain("Circuit de Spa-Francorchamps");
        expect(markup).toContain("Ferrari 499P 2023");
        expect(urls.map((url) => url.pathname).sort()).toEqual([
          "/api/car-name/ferrari_499p_2023",
          "/api/track-name/spa_2023%2Fspawec",
        ]);
      });
    } finally {
      telemetryStore.setState(() => previousTelemetry);
    }
  });
});
