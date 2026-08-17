import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { Hono } from "hono";
import sharp from "sharp";
import { trackConfigurationCanonicalId, type TrackConfiguration } from "../shared/racing/tracks/configuration";
import { resolveTrackName } from "../shared/racing/tracks/resolve-name";
import { trackConfigurationDevRoutes } from "../server/routes/dev/track-configuration-routes";
import { trackImageryDevRoutes } from "../server/routes/dev/track-imagery-routes";
import { trackImageryRoutes } from "../server/routes/tracks/imagery-routes";
import { trackConfigurationPath } from "../server/tracks/configuration";
import { trackImageryLayoutPath, trackImageryVenueDirectory } from "../server/tracks/imagery";

const venueRootId = `route-test-${Date.now()}`;
const venueId = `${venueRootId}/historical/2011`;
const gameId = "iracing" as const;
const trackOrdinal = 900_000 + Math.floor(Math.random() * 90_000);
const venueDirectory = trackImageryVenueDirectory(venueRootId);
const layoutPath = trackImageryLayoutPath(gameId, trackOrdinal);
const configurationPath = trackConfigurationPath(gameId, trackOrdinal);
const app = new Hono().route("/", trackConfigurationDevRoutes).route("/", trackImageryDevRoutes).route("/", trackImageryRoutes);
const source = { name: "Generated test texture", license: "owned", attribution: "" };

afterAll(() => {
  rmSync(venueDirectory, { recursive: true, force: true });
  if (existsSync(layoutPath)) unlinkSync(layoutPath);
  if (existsSync(configurationPath)) unlinkSync(configurationPath);
});

test("persists one opaque venue base with selected transparent layout layers", async () => {
  const baseBytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 20, g: 40, b: 60 } } })
    .png()
    .toBuffer();
  const baseManifest = {
    version: 1,
    venueId,
    calibration: { originLatitudeDeg: 29, originLongitudeDeg: -81, imageToEnu: [200, 0, 0, -100, -100, 50] },
    base: { image: "ignored.png", source },
    layers: [],
  };
  const baseForm = new FormData();
  baseForm.set("file", new File([baseBytes], "base.png", { type: "image/png" }));
  baseForm.set("manifest", JSON.stringify(baseManifest));
  const baseResponse = await app.request(`/api/dev/track-imagery/venues/base?venueId=${encodeURIComponent(venueId)}`, { method: "POST", body: baseForm });
  expect(baseResponse.status).toBe(201);

  const layerBytes = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toBuffer();
  const layerForm = new FormData();
  layerForm.set("file", new File([layerBytes], "road-course.png", { type: "image/png" }));
  layerForm.set("layer", JSON.stringify({ id: "road-course", kind: "layout", image: "ignored.png", opacity: 0.65, source }));
  const layerResponse = await app.request(`/api/dev/track-imagery/venues/layers/road-course?venueId=${encodeURIComponent(venueId)}`, { method: "POST", body: layerForm });
  expect(layerResponse.status).toBe(201);

  const configurationResponse = await app.request(`/api/dev/track-configurations/${trackOrdinal}?gameId=${gameId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      gameId,
      trackOrdinal,
      venue: { id: venueRootId, name: "Route Test" },
      subVenues: [
        { id: "historical", name: "Historical" },
        { id: "2011", name: "2011" },
      ],
      track: { id: "road-course", name: "Road Course" },
      confirmation: null,
    }),
  });
  expect(configurationResponse.status).toBe(200);

  const layoutResponse = await app.request(`/api/dev/track-imagery/layouts/${trackOrdinal}?gameId=${gameId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, gameId, trackOrdinal, layers: ["road-course"] }),
  });
  expect(layoutResponse.status).toBe(200);

  const runtimeResponse = await app.request(`/api/track-imagery/${trackOrdinal}?gameId=${gameId}`);
  expect(runtimeResponse.status).toBe(200);
  const imagery = (await runtimeResponse.json()) as { venueId: string; textures: Array<{ id: string; kind: string; opacity: number; url: string }> };
  expect(imagery.venueId).toBe(venueId);
  expect(imagery.textures.map(({ id, kind, opacity }) => ({ id, kind, opacity }))).toEqual([
    { id: "base", kind: "base", opacity: 1 },
    { id: "road-course", kind: "layout", opacity: 0.65 },
  ]);

  const baseTexture = await app.request(imagery.textures[0]!.url);
  const layerTexture = await app.request(imagery.textures[1]!.url);
  expect(baseTexture.status).toBe(200);
  expect(layerTexture.status).toBe(200);
  expect(baseTexture.headers.get("content-type")).toBe("image/png");
  expect(layerTexture.headers.get("content-type")).toBe("image/png");

  const confirmationResponse = await app.request(`/api/dev/track-configurations/${trackOrdinal}/confirmation?gameId=${gameId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmedAt: "2026-08-17", confirmedBy: "RaceIQ maintainer", commitId: "abcdef1" }),
  });
  expect(confirmationResponse.status).toBe(200);
  const confirmed = (await confirmationResponse.json()) as TrackConfiguration;
  expect(trackConfigurationCanonicalId(confirmed)).toBe(`${venueId}/road-course`);
  expect(confirmed.confirmation).toEqual({ confirmedAt: "2026-08-17", confirmedBy: "RaceIQ maintainer", commitId: "abcdef1" });
  expect(resolveTrackName(trackOrdinal, gameId)).toBe("Route Test — Historical — 2011 — Road Course");

  const indexResponse = await app.request("/api/dev/track-configurations");
  expect(indexResponse.status).toBe(200);
  const configurations = (await indexResponse.json()) as TrackConfiguration[];
  expect(configurations.some((configuration) => configuration.gameId === gameId && configuration.trackOrdinal === trackOrdinal && trackConfigurationCanonicalId(configuration) === `${venueId}/road-course`)).toBe(true);

  const resaveResponse = await app.request(`/api/dev/track-configurations/${trackOrdinal}?gameId=${gameId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirmed),
  });
  expect(resaveResponse.status).toBe(200);
  expect(await resaveResponse.json()).toMatchObject({ track: { id: "road-course", name: "Road Course" }, confirmation: null });
});
