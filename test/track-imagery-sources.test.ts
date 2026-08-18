import { expect, test } from "bun:test";
import sharp from "sharp";
import { loadOpenTrackImageryAsset, loadOpenTrackImageryRaster, searchOpenTrackImagery, trackImageryRasterDimensions } from "../server/tracks/imagery-sources";

const bounds = { west: 39.24, south: -6.775, east: 39.243, north: -6.77 };
const openAerialMapId = "5a00c655bac48e5b1cf76247";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function catalogFetcher(tile: Uint8Array | null = null, oamResolutionM = 0.2): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.includes("USGSNAIPImagery/ImageServer/query")) {
      return json({ features: [{ attributes: { Year: 2024, acquisition_date: Date.UTC(2024, 4, 1), resolution_value: 0.6 } }] });
    }
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
    if (url.startsWith("https://tiles.openaerialmap.org/") && tile) {
      return new Response(Uint8Array.from(tile).buffer, { headers: { "Content-Type": "image/png" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

test("lists reusable HQ imagery candidates with provenance", async () => {
  const result = await searchOpenTrackImagery(bounds, catalogFetcher());
  expect(result.notices).toEqual([]);
  expect(result.candidates.map((candidate) => [candidate.provider, candidate.quality])).toEqual([
    ["openaerialmap", "hq"],
    ["naip", "hq"],
  ]);
  expect(result.candidates.every((candidate) => candidate.quality === "hq")).toBe(true);
  expect(result.candidates[0]).toMatchObject({ id: `oam-${openAerialMapId}`, license: "CC BY 4.0", resolutionM: 0.2 });
  expect(result.candidates[1]).toMatchObject({ id: "naip", resolutionM: 0.6 });
});

test("renders a GPS-bounded OpenAerialMap tile mosaic as one opaque texture", async () => {
  const tile = new Uint8Array(
    await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 120, b: 80 } } })
      .png()
      .toBuffer(),
  );
  const raster = await loadOpenTrackImageryRaster(`oam-${openAerialMapId}`, bounds, "preview", catalogFetcher(tile));
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
    const asset = await loadOpenTrackImageryAsset(`oam-${openAerialMapId}`, bounds, 512, catalogFetcher(tile, sourceResolutionM));
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

test("rejects LQ candidates from asset import", async () => {
  await expect(loadOpenTrackImageryAsset("nasa-hls-2025-01-01", bounds, 512, catalogFetcher())).rejects.toThrow();
});

test("preview dimensions preserve geographic aspect ratio without asset-size cap", () => {
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.8, north: 40.05 }, 1_000)).toEqual({ width: 1_000, height: 326 });
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.95, north: 40.2 }, 1_000)).toEqual({ width: 191, height: 1_000 });
});
