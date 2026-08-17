import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { Hono } from "hono";
import sharp from "sharp";
import { trackImageryDevRoutes } from "../server/routes/dev/track-imagery-routes";
import { trackImageryRoutes } from "../server/routes/tracks/imagery-routes";
import { trackImageryLayoutPath, trackImageryVenueDirectory } from "../server/tracks/imagery";

const venueId = `route-test-${Date.now()}`;
const gameId = "iracing" as const;
const trackOrdinal = 900_000 + Math.floor(Math.random() * 90_000);
const venueDirectory = trackImageryVenueDirectory(venueId);
const layoutPath = trackImageryLayoutPath(gameId, trackOrdinal);
const app = new Hono().route("/", trackImageryDevRoutes).route("/", trackImageryRoutes);
const source = { name: "Generated test texture", license: "owned", attribution: "" };

afterAll(() => {
  rmSync(venueDirectory, { recursive: true, force: true });
  if (existsSync(layoutPath)) unlinkSync(layoutPath);
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
  const baseResponse = await app.request(`/api/dev/track-imagery/venues/${venueId}/base`, { method: "POST", body: baseForm });
  expect(baseResponse.status).toBe(201);

  const layerBytes = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toBuffer();
  const layerForm = new FormData();
  layerForm.set("file", new File([layerBytes], "road-course.png", { type: "image/png" }));
  layerForm.set("layer", JSON.stringify({ id: "road-course", kind: "layout", image: "ignored.png", opacity: 0.65, source }));
  const layerResponse = await app.request(`/api/dev/track-imagery/venues/${venueId}/layers/road-course`, { method: "POST", body: layerForm });
  expect(layerResponse.status).toBe(201);

  const layoutResponse = await app.request(`/api/dev/track-imagery/layouts/${trackOrdinal}?gameId=${gameId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, gameId, trackOrdinal, venueId, layers: ["road-course"] }),
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
});
