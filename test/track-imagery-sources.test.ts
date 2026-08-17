import { expect, test } from "bun:test";
import sharp from "sharp";
import { loadOpenTrackImageryRaster, searchOpenTrackImagery, trackImageryRasterDimensions } from "../server/tracks/imagery-sources";

const bounds = { west: 39.24, south: -6.775, east: 39.243, north: -6.77 };
const openAerialMapId = "5a00c655bac48e5b1cf76247";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function catalogFetcher(tile: Uint8Array | null = null): typeof fetch {
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
        provider: "Open survey",
        acquisition_start: "2025-01-02T00:00:00Z",
        gsd: 0.2,
        bbox: [39.2, -6.8, 39.3, -6.7],
        properties: { license: "CC-BY 4.0", tms: "https://tiles.openaerialmap.org/test/{z}/{x}/{y}.png" },
      };
      return json({ meta: { license: "CC-BY 4.0" }, results: url.includes("/meta?") ? [item] : item });
    }
    if (url.includes("planetarycomputer.microsoft.com/api/stac")) {
      return json({ features: [{ properties: { datetime: "2026-07-10T10:00:00Z", "eo:cloud_cover": 2.5 } }] });
    }
    if (url.startsWith("https://tiles.openaerialmap.org/") && tile) {
      return new Response(Uint8Array.from(tile).buffer, { headers: { "Content-Type": "image/png" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

test("lists reusable HQ and LQ imagery candidates with provenance", async () => {
  const result = await searchOpenTrackImagery(bounds, catalogFetcher());
  expect(result.notices).toEqual([]);
  expect(result.candidates.map((candidate) => [candidate.provider, candidate.quality])).toEqual([
    ["openaerialmap", "hq"],
    ["naip", "hq"],
    ["nasa-hls", "lq"],
  ]);
  expect(result.candidates[0]).toMatchObject({ id: `oam-${openAerialMapId}`, license: "CC BY 4.0", resolutionM: 0.2 });
  expect(result.candidates[2]).toMatchObject({ id: "nasa-hls-2026-07-10", resolutionM: 30 });
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

test("preserves geographic aspect ratio within quality tier limits", () => {
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.8, north: 40.05 }, 4_000)).toEqual({ width: 4_000, height: 1_306 });
  expect(trackImageryRasterDimensions({ west: -2, south: 40, east: -1.95, north: 40.2 }, 1_400)).toEqual({ width: 268, height: 1_400 });
});
