import { expect, test } from "bun:test";
import sharp from "sharp";
import {
  assessTrackImageryOutputBudget,
  loadOpenTrackImageryAsset,
  loadOpenTrackImageryRaster,
  searchOpenTrackImagery,
  trackImageryOutputEstimate,
  trackImageryRasterDimensions,
} from "../server/tracks/imagery-sources";

const bounds = { west: 39.24, south: -6.775, east: 39.243, north: -6.77 };
const location = { center: { latitudeDeg: -6.7725, longitudeDeg: 39.2415 }, country: "Tanzania", region: "" };
const openAerialMapId = "5a00c655bac48e5b1cf76247";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function catalogFetcher(tile: Uint8Array | null = null, oamResolutionM = 0.2): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith(`/meta/${openAerialMapId}`) || url.includes("api.openaerialmap.org/meta?")) {
      const item = {
        _id: openAerialMapId,
        uuid: "https://example.test/open-image.tif",
        title: "Open test image",
        gsd: oamResolutionM,
        acquisition_start: "2025-01-02T00:00:00Z",
        bbox: [39.2, -6.8, 39.3, -6.7],
        properties: { license: "CC-BY 4.0", tms: "https://tiles.openaerialmap.org/test/{z}/{x}/{y}.png" },
      };
      return json({ meta: { license: "CC-BY 4.0" }, results: url.includes("/meta?") ? [item] : item });
    }
    if (url.includes("planetarycomputer.microsoft.com/api/stac/v1/search")) {
      return json({
        features: [
          {
            id: "S2A_fixture",
            collection: "sentinel-2-l2a",
            bbox: [-180, -90, 180, 90],
            properties: { datetime: "2025-01-02T00:00:00Z", "eo:cloud_cover": 2 },
            assets: { visual: { href: "https://example.test/visual.tif" } },
          },
        ],
      });
    }
    if (url.startsWith("https://tiles.openaerialmap.org/") && tile) {
      return new Response(Uint8Array.from(tile).buffer, { headers: { "Content-Type": "image/png" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

test("lists reusable imagery options grouped by source with provenance", async () => {
  const result = await searchOpenTrackImagery(bounds, location, catalogFetcher());
  expect(result.notices).toEqual([]);
  expect(result.sources.map((source) => [source.id, source.name])).toEqual([
    ["openaerialmap", "OpenAerialMap"],
    ["sentinel-2-l2a", "Sentinel-2 L2A true color"],
  ]);
  const candidates = result.sources.flatMap((source) => source.candidates);
  expect(candidates.map((candidate) => [candidate.provider, candidate.quality])).toEqual([
    ["openaerialmap", "hq"],
    ["sentinel-2-l2a", "context"],
  ]);
  expect(candidates[0]).toMatchObject({
    id: `openaerialmap:${openAerialMapId}`,
    license: "CC BY 4.0",
    sourceResolutionM: 0.2,
    coverage: "full",
    geographicReliability: "community",
    providerStability: "opportunistic",
    redistribution: "allowed",
  });
  expect(candidates[1]).toMatchObject({
    id: "sentinel-2-l2a:S2A_fixture",
    sourceResolutionM: 10,
    quality: "context",
    coverage: "full",
    geographicReliability: "satellite",
    providerStability: "authoritative",
    redistribution: "allowed",
  });
});

test("renders a GPS-bounded OpenAerialMap tile mosaic as one opaque texture", async () => {
  const tile = new Uint8Array(
    await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 120, b: 80 } } })
      .png()
      .toBuffer(),
  );
  const raster = await loadOpenTrackImageryRaster(`openaerialmap:${openAerialMapId}`, bounds, location, "preview", catalogFetcher(tile));
  const metadata = await sharp(raster.bytes).metadata();
  expect(raster.candidate).toMatchObject({ provider: "openaerialmap", quality: "hq" });
  expect(metadata).toMatchObject({ format: "webp", width: raster.width, height: raster.height, hasAlpha: false });
  expect(raster.width).toBeLessThanOrEqual(1_000);
  expect(raster.height).toBeLessThanOrEqual(1_000);
});

test("builds HQ tile grids from physical spans without oversampling or upscaling", async () => {
  const tile = new Uint8Array(
    await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 120, b: 80 } } })
      .png()
      .toBuffer(),
  );
  const latitudeRad = (((bounds.south + bounds.north) / 2) * Math.PI) / 180;
  const widthM = ((bounds.east - bounds.west) * Math.PI * 6_378_137 * Math.cos(latitudeRad)) / 180;
  const heightM = ((bounds.north - bounds.south) * Math.PI * 6_378_137) / 180;
  for (const [sourceResolutionM, storedResolutionM] of [
    [0.6, 0.6],
    [0.25, 0.25],
    [0.08, 0.1],
  ] as const) {
    const asset = await loadOpenTrackImageryAsset(`openaerialmap:${openAerialMapId}`, bounds, location, 512, catalogFetcher(tile, sourceResolutionM));
    expect(asset.candidate.quality).toBe("hq");
    expect(asset.resolutionM).toBe(storedResolutionM);
    expect(asset.width).toBe(Math.ceil(widthM / storedResolutionM));
    expect(asset.height).toBe(Math.ceil(heightM / storedResolutionM));
    expect(asset.tileSize).toBe(512);
    expect(asset.columns).toBe(Math.ceil(asset.width / 512));
    expect(asset.rows).toBe(Math.ceil(asset.height / 512));
    const rows = [];
    for await (const candidateTile of asset.tiles) rows.push(candidateTile);
    expect(rows.length).toBe(asset.columns * asset.rows);
    expect(rows.find((candidateTile) => candidateTile.x === asset.columns - 1 && candidateTile.y === asset.rows - 1)).toMatchObject({
      width: asset.width - (asset.columns - 1) * 512,
      height: asset.height - (asset.rows - 1) * 512,
    });
  }
});

test("batches provider downloads into source chunks before creating internal tiles", async () => {
  const sourceBounds = { west: -81.085, south: 29.178, east: -81.061, north: 29.19 };
  const sourceLocation = { center: { latitudeDeg: 29.185169, longitudeDeg: -81.072722 }, country: "USA", region: "Daytona Beach, Florida" };
  let exportRequests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/query")) {
      return json({ features: [{ attributes: { Year: 2022, acquisition_date: Date.UTC(2022, 0, 1), resolution_value: 0.6 } }] });
    }
    if (url.pathname.endsWith("/exportImage")) {
      exportRequests += 1;
      const [width, height] = (url.searchParams.get("size") ?? "").split(",").map(Number);
      const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 80, g: 100, b: 120 } } })
        .jpeg()
        .toBuffer();
      return new Response(Uint8Array.from(bytes).buffer, { headers: { "Content-Type": "image/jpeg" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const asset = await loadOpenTrackImageryAsset("usgs-naip:latest", sourceBounds, sourceLocation, 512, fetcher);
  let internalTiles = 0;
  for await (const _tile of asset.tiles) internalTiles += 1;
  expect(internalTiles).toBe(asset.columns * asset.rows);
  const naipSourceChunkSize = 512 * Math.floor(4_000 / 512);
  expect(exportRequests).toBe(Math.ceil(asset.width / naipSourceChunkSize) * Math.ceil(asset.height / naipSourceChunkSize));
  expect(exportRequests).toBeLessThan(internalTiles);
});

test("rejects unknown legacy NASA/HLS candidates from asset import", async () => {
  await expect(loadOpenTrackImageryAsset("nasa-hls-2025-01-01", bounds, location, 512, catalogFetcher())).rejects.toThrow();
});

test("budgets complete provider output before source pixels are downloaded", async () => {
  const fiveKilometresInDegrees = (5_000 / 6_378_137) * (180 / Math.PI);
  const largeBounds = {
    west: 39.24 - fiveKilometresInDegrees / 2,
    south: -6.7725 - fiveKilometresInDegrees / 2,
    east: 39.24 + fiveKilometresInDegrees / 2,
    north: -6.7725 + fiveKilometresInDegrees / 2,
  };
  const estimate = trackImageryOutputEstimate(largeBounds, 0.1);
  expect(estimate.width).toBeGreaterThanOrEqual(49_000);
  expect(estimate.height).toBeGreaterThanOrEqual(49_000);
  expect(estimate.totalPixels).toBeGreaterThan(2_400_000_000);
  expect(estimate.totalTiles).toBe(estimate.columns * estimate.rows);
  expect(estimate.estimatedUncompressedBytes).toBe(estimate.totalPixels * 4);
  expect(estimate.estimatedPackBytes.minimum).toBeLessThan(estimate.estimatedPackBytes.maximum);
  expect(estimate.estimatedJobDurationMs).toBeGreaterThan(0);

  const budget = assessTrackImageryOutputBudget(estimate, 100 * 1024 ** 3);
  expect(budget.safe).toBe(false);
  expect(budget.problems).toEqual(
    expect.arrayContaining([expect.stringContaining("pixels; maximum is"), expect.stringContaining("tiles; maximum is"), expect.stringContaining("30 minute job limit")]),
  );
  expect(budget.maximumConcurrency).toBe(1);
  expect(budget.maximumJobDurationMs).toBe(30 * 60 * 1_000);

  let sourcePixelRequests = 0;
  const metadataFetcher = catalogFetcher(null, 0.1);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://tiles.openaerialmap.org/")) sourcePixelRequests += 1;
    return metadataFetcher(input, init);
  }) as typeof fetch;
  await expect(loadOpenTrackImageryAsset(`openaerialmap:${openAerialMapId}`, largeBounds, location, 512, fetcher)).rejects.toThrow("Unsafe imagery output");
  expect(sourcePixelRequests).toBe(0);
});

test("includes temporary database overhead and available disk in output budget", () => {
  const estimate = trackImageryOutputEstimate(bounds, 0.25);
  const enoughDisk = assessTrackImageryOutputBudget(estimate, 10 * 1024 ** 3);
  expect(enoughDisk.safe).toBe(true);
  expect(enoughDisk.requiredDiskBytes).toBeGreaterThan(estimate.estimatedPackBytes.maximum * 2);

  const insufficientDisk = assessTrackImageryOutputBudget(estimate, enoughDisk.requiredDiskBytes - 1);
  expect(insufficientDisk.safe).toBe(false);
  expect(insufficientDisk.problems).toContain("Available disk space is below the conservative pack, temporary database, and reserve requirement");
});

test("preview dimensions preserve geographic aspect ratio without asset-size cap", () => {
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.8, north: 40.05 }, 1_000)).toEqual({ width: 1_000, height: 326 });
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.95, north: 40.2 }, 1_000)).toEqual({ width: 191, height: 1_000 });
});
