import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { trackConfigurationCanonicalId, type TrackConfiguration } from "../shared/racing/tracks/configuration";
import { resolveTrackName } from "../shared/racing/tracks/resolve-name";
import { TRACK_IMAGERY_MANIFEST_VERSION, TRACK_IMAGERY_PACKAGE_NAME, type TrackImagery } from "../shared/racing/tracks/imagery";
import { trackConfigurationDevRoutes } from "../server/routes/dev/track-configuration-routes";
import { trackImageryDevRoutes } from "../server/routes/dev/track-imagery-routes";
import { trackImageryRoutes } from "../server/routes/tracks/imagery-routes";
import { deleteTrackConfiguration } from "../server/tracks/configuration";
import { readTrackImageryPackMetadata, readTrackImageryPackTile, writeTrackImageryPack, type TrackImageryPackTile } from "../server/tracks/imagery-pack";
import { trackImageryLayoutPath, trackImageryVenueDirectory } from "../server/tracks/imagery";

const venueRootId = `route-test-${Date.now()}`;
const venueId = `${venueRootId}/historical/2011`;
const gameId = "iracing" as const;
const trackOrdinal = 900_000 + Math.floor(Math.random() * 90_000);
const peerTrackOrdinal = trackOrdinal + 1;
const venueRootDirectory = trackImageryVenueDirectory(venueRootId);
const venueDirectory = trackImageryVenueDirectory(venueId);
const layoutPath = trackImageryLayoutPath(gameId, trackOrdinal);
const peerLayoutPath = trackImageryLayoutPath(gameId, peerTrackOrdinal);
const app = new Hono().route("/", trackConfigurationDevRoutes).route("/", trackImageryDevRoutes).route("/", trackImageryRoutes);
const source = { name: "Generated test texture", provider: "test-hq", license: "owned", attribution: "", sourceResolutionM: 0.25, storedResolutionM: 0.25 };

afterAll(() => {
  rmSync(venueRootDirectory, { recursive: true, force: true });
  deleteTrackConfiguration(gameId, trackOrdinal);
  deleteTrackConfiguration(gameId, peerTrackOrdinal);
  for (const path of [layoutPath, peerLayoutPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("serves one physical HQ venue package to two layouts with transparent overlays", async () => {
  const packTileBytes = new Uint8Array(
    await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 20, g: 40, b: 60 } } })
      .webp()
      .toBuffer(),
  );
  const packMetadata = {
    schemaVersion: 1 as const,
    tier: "hq" as const,
    width: 1_025,
    height: 513,
    tileSize: 512,
    columns: 3,
    rows: 2,
    resolutionM: 0.25,
    bounds: { west: -81.01, south: 28.99, east: -80.99, north: 29.01 },
  };
  const packTiles: TrackImageryPackTile[] = [
    { tier: "hq", x: 0, y: 0, width: 512, height: 512, format: "webp", data: packTileBytes },
    { tier: "hq", x: 1, y: 0, width: 512, height: 512, format: "webp", data: packTileBytes },
    { tier: "hq", x: 2, y: 0, width: 1, height: 512, format: "webp", data: packTileBytes },
    { tier: "hq", x: 0, y: 1, width: 512, height: 1, format: "webp", data: packTileBytes },
    { tier: "hq", x: 1, y: 1, width: 512, height: 1, format: "webp", data: packTileBytes },
    { tier: "hq", x: 2, y: 1, width: 1, height: 1, format: "webp", data: packTileBytes },
  ];
  mkdirSync(resolve(venueDirectory, "layers"), { recursive: true });
  await writeTrackImageryPack(resolve(venueDirectory, "imagery.rqi"), packMetadata, packTiles);
  const calibration = { originLatitudeDeg: 29, originLongitudeDeg: -81, imageToEnu: [200, 0, 0, -100, -100, 50] as [number, number, number, number, number, number] };
  const baseManifest = {
    version: TRACK_IMAGERY_MANIFEST_VERSION,
    venueId,
    calibration,
    base: { pack: TRACK_IMAGERY_PACKAGE_NAME, tileSize: 512, bounds: packMetadata.bounds, source },
    layers: [{ id: "road-course", kind: "layout", image: "road-course.webp", opacity: 0.65, source }],
  };
  writeFileSync(resolve(venueDirectory, "manifest.json"), `${JSON.stringify(baseManifest)}\n`, "utf8");
  const layerBytes = await sharp({ create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .webp()
    .toBuffer();
  expect(existsSync(resolve(venueDirectory, "base.webp"))).toBe(false);
  writeFileSync(resolve(venueDirectory, "layers", "road-course.webp"), layerBytes);

  async function saveConfiguration(ordinal: number): Promise<void> {
    const response = await app.request(`/api/dev/track-configurations/${ordinal}?gameId=${gameId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        gameId,
        trackOrdinal: ordinal,
        venue: { id: venueRootId, name: "Route Test" },
        subVenues: [
          { id: "historical", name: "Historical" },
          { id: "2011", name: "2011" },
        ],
        track: { id: ordinal === trackOrdinal ? "road-course" : "alternate-course", name: ordinal === trackOrdinal ? "Road Course" : "Alternate Course" },
        confirmation: null,
      }),
    });
    expect(response.status).toBe(200);
  }
  async function saveLayout(ordinal: number, layers: string[]): Promise<void> {
    const response = await app.request(`/api/dev/track-imagery/layouts/${ordinal}?gameId=${gameId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: TRACK_IMAGERY_MANIFEST_VERSION, gameId, trackOrdinal: ordinal, layers }),
    });
    expect(response.status).toBe(200);
  }
  await saveConfiguration(trackOrdinal);
  await saveConfiguration(peerTrackOrdinal);
  await saveLayout(trackOrdinal, ["road-course"]);
  await saveLayout(peerTrackOrdinal, []);

  const runtimeResponse = await app.request(`/api/track-imagery/${trackOrdinal}?gameId=${gameId}`);
  const peerRuntimeResponse = await app.request(`/api/track-imagery/${peerTrackOrdinal}?gameId=${gameId}`);
  expect(runtimeResponse.status).toBe(200);
  expect(peerRuntimeResponse.status).toBe(200);
  const imagery = (await runtimeResponse.json()) as TrackImagery;
  const peerImagery = (await peerRuntimeResponse.json()) as TrackImagery;
  expect(imagery.version).toBe(2);
  expect(imagery.venueId).toBe(venueId);
  expect(peerImagery.venueId).toBe(venueId);
  expect(imagery.calibration).toEqual(peerImagery.calibration);
  const normalizedRectangles = packTiles.map((candidateTile) => ({
    x: (candidateTile.x * imagery.base.tileSize) / imagery.base.width,
    y: (candidateTile.y * imagery.base.tileSize) / imagery.base.height,
    width: candidateTile.width / imagery.base.width,
    height: candidateTile.height / imagery.base.height,
  }));
  expect(normalizedRectangles).toContainEqual({ x: 1024 / 1025, y: 512 / 513, width: 1 / 1025, height: 1 / 513 });
  expect(imagery.calibration).toEqual(calibration);
  expect(imagery.base).toMatchObject({ tier: "hq", width: 1_025, height: 513, tileSize: 512, columns: 3, rows: 2, resolutionM: 0.25 });
  expect(imagery.base).not.toHaveProperty("calibration");
  expect(Object.keys(imagery.base).sort()).toEqual(["bounds", "columns", "contentHash", "height", "resolutionM", "rows", "source", "tier", "tileSize", "tileUrlTemplate", "width"].sort());
  expect(imagery.textures.map(({ id, kind, opacity }) => ({ id, kind, opacity }))).toEqual([{ id: "road-course", kind: "layout", opacity: 0.65 }]);
  expect(peerImagery.textures).toEqual([]);
  expect(imagery.base.tileUrlTemplate).toContain(`/api/track-imagery/${trackOrdinal}/base/hq/{x}/{y}`);
  expect(peerImagery.base.tileUrlTemplate).toContain(`/api/track-imagery/${peerTrackOrdinal}/base/hq/{x}/{y}`);
  const tileUrl = imagery.base.tileUrlTemplate.replace("{x}", "2").replace("{y}", "1");
  const peerTileUrl = peerImagery.base.tileUrlTemplate.replace("{x}", "2").replace("{y}", "1");
  const tileResponse = await app.request(tileUrl);
  const peerTileResponse = await app.request(peerTileUrl);
  expect(tileResponse.status).toBe(200);
  expect(peerTileResponse.status).toBe(200);
  expect(tileResponse.headers.get("content-type")).toBe("image/webp");
  expect(tileResponse.headers.get("cache-control")).toContain("immutable");
  expect(tileResponse.headers.get("etag")).toBeTruthy();
  expect(tileResponse.headers.get("etag")).toBe(peerTileResponse.headers.get("etag"));
  expect(new Uint8Array(await tileResponse.arrayBuffer())).toEqual(packTileBytes);
  const layerTexture = await app.request(imagery.textures[0]!.url);
  expect(layerTexture.status).toBe(200);
  expect(layerTexture.headers.get("content-type")).toBe("image/webp");

  const sourceBounds = { west: 5.9697, south: 50.4368, east: 5.97, north: 50.4371 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geoservices.wallonie.be/arcgis/rest/services/IMAGERIE/ORTHO_2023_ETE/MapServer/0?f=json")) {
      return new Response(JSON.stringify({ type: "Raster Layer", description: "Imagerie couvrant le territoire wallon à une résolution de 25 cm." }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_2023_ETE/MapServer/WMSServer")) {
      return new Response(Uint8Array.from(packTileBytes).buffer, { headers: { "Content-Type": "image/jpeg" } });
    }
    throw new Error(`Unexpected external request ${url}`);
  }) as typeof fetch;
  let sourceImportResponse: Response;
  try {
    sourceImportResponse = await app.request(`/api/dev/track-imagery/venues/base/source?venueId=${encodeURIComponent(venueId)}&gameId=iracing&trackOrdinal=523`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: "wallonia-spw:ortho_2023_ete",
        bounds: sourceBounds,
        calibration,
        gameId,
        trackOrdinal: 523,
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(sourceImportResponse.status).toBe(201);
  expect(await sourceImportResponse.json()).toMatchObject({
    base: {
      pack: "imagery.rqi",
      tileSize: 512,
      bounds: sourceBounds,
      source: {
        provider: "wallonia-spw",
        sourceResolutionM: 0.25,
        storedResolutionM: 0.25,
        quality: "hq",
        coverage: "full",
        geographicReliability: "authoritative",
        providerStability: "stable",
        redistribution: "allowed",
      },
    },
  });
  const importedMetadata = readTrackImageryPackMetadata(resolve(venueDirectory, "imagery.rqi"));
  expect(importedMetadata).toMatchObject({ tier: "hq", tileSize: 512, resolutionM: 0.25, bounds: sourceBounds });
  expect(existsSync(resolve(venueDirectory, "imagery.rqi.tmp"))).toBe(false);
  expect(existsSync(resolve(venueDirectory, "base.webp"))).toBe(false);

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
});

test("imports resized manual imagery across a multi-tile grid", async () => {
  const manualVenueId = `${venueRootId}/manual`;
  const manualDirectory = trackImageryVenueDirectory(manualVenueId);
  const bounds = { west: -81.01, south: 28.99, east: -80.99, north: 29.01 };
  const calibration = { originLatitudeDeg: 29, originLongitudeDeg: -81, imageToEnu: [200, 0, 0, -100, -100, 50] };
  const image = await sharp({ create: { width: 2_050, height: 1_026, channels: 3, background: { r: 20, g: 40, b: 60 } } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("file", new File([image], "manual.png", { type: "image/png" }));
  form.set(
    "manifest",
    JSON.stringify({
      version: TRACK_IMAGERY_MANIFEST_VERSION,
      venueId: manualVenueId,
      calibration,
      base: {
        pack: TRACK_IMAGERY_PACKAGE_NAME,
        tileSize: 512,
        bounds,
        source: { name: "Manual test texture", provider: "manual", license: "owned", attribution: "", sourceResolutionM: 0.05, storedResolutionM: 0.05 },
      },
      layers: [],
    }),
  );

  const response = await app.request(`/api/dev/track-imagery/venues/base?venueId=${encodeURIComponent(manualVenueId)}`, { method: "POST", body: form });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    base: { pack: TRACK_IMAGERY_PACKAGE_NAME, tileSize: 512, bounds, source: { provider: "manual", sourceResolutionM: 0.05, storedResolutionM: 0.1, quality: "hq" } },
  });

  const packPath = resolve(manualDirectory, TRACK_IMAGERY_PACKAGE_NAME);
  const metadata = readTrackImageryPackMetadata(packPath);
  expect(metadata).toMatchObject({ width: 1_025, height: 513, tileSize: 512, columns: 3, rows: 2, resolutionM: 0.1 });
  const expectedSizes = [
    [512, 512],
    [512, 512],
    [1, 512],
    [512, 1],
    [512, 1],
    [1, 1],
  ] as const;
  for (let y = 0; y < metadata.rows; y += 1) {
    for (let x = 0; x < metadata.columns; x += 1) {
      const tile = readTrackImageryPackTile(packPath, x, y, metadata);
      const [width, height] = expectedSizes[y * metadata.columns + x]!;
      expect(tile).toMatchObject({ tier: "hq", x, y, width, height, format: "webp" });
      expect(await sharp(tile!.data).metadata()).toMatchObject({ format: "webp", width, height });
    }
  }
});

test("resolves lap-free imagery calibration through an exact iRacing layout peer", async () => {
  const response = await app.request("/api/dev/track-imagery/reference/10?gameId=f1-2025");
  expect(response.status).toBe(200);
  const reference = (await response.json()) as {
    sourceTrackOrdinal: number;
    match: string;
    outlineSource: string;
    center: { latitudeDeg: number; longitudeDeg: number };
    geographicPositions: Array<{ latitudeDeg: number; longitudeDeg: number }>;
  };
  expect(reference).toMatchObject({
    sourceTrackOrdinal: 523,
    match: "assigned-identity",
    center: { latitudeDeg: 50.4369118, longitudeDeg: 5.969856 },
  });
  expect(reference.outlineSource).not.toBe("estimated");
  expect(reference.geographicPositions.length).toBeGreaterThan(100);
  expect(reference.geographicPositions.every((point) => Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg))).toBe(true);
});

test("imagery source search requires server track identity", async () => {
  const response = await app.request("/api/dev/track-imagery/sources/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bounds: { west: 5.9697, south: 50.4368, east: 5.97, north: 50.4371 } }),
  });
  expect(response.status).toBe(400);
});
