import { expect, test } from "bun:test";
import sharp from "sharp";
import {
  TRACK_IMAGERY_PROVIDERS,
  rankTrackImageryCandidates,
  resolveTrackImageryProviderCandidate,
  searchTrackImageryProviders,
  trackImageryProvidersForLocation,
} from "../server/tracks/imagery-providers";
import { sentinel2Provider } from "../server/tracks/imagery-providers/sentinel2";
import { naipProvider } from "../server/tracks/imagery-providers/naip";
import { request } from "../server/tracks/imagery-providers/http";
import type { TrackImageryCandidate } from "../shared/racing/tracks/imagery";
import type { TrackImageryFetcher, TrackImageryLocation } from "../server/tracks/imagery-providers/types";

const spaBounds = { west: 5.95, south: 50.42, east: 5.99, north: 50.46 };
const zandvoortBounds = { west: 4.52, south: 52.37, east: 4.54, north: 52.39 };
const usBounds = { west: -81.01, south: 28.99, east: -80.99, north: 29.01 };
const globalBounds = { west: -0.01, south: 0.01, east: 0.01, north: 0.03 };
const spa: TrackImageryLocation = { center: { latitudeDeg: 50.4369118, longitudeDeg: 5.969856 }, country: "Belgium", region: "Francorchamps, Liège" };
const zandvoort: TrackImageryLocation = { center: { latitudeDeg: 52.38, longitudeDeg: 4.53 }, country: "Netherlands", region: "North Holland" };
const unitedStates: TrackImageryLocation = { center: { latitudeDeg: 29, longitudeDeg: -81 }, country: "USA", region: "Florida" };
const global: TrackImageryLocation = { center: { latitudeDeg: 0.02, longitudeDeg: 0 }, country: "", region: "" };

function candidate(overrides: Partial<TrackImageryCandidate> & Pick<TrackImageryCandidate, "id">): TrackImageryCandidate {
  return {
    provider: "fixture",
    quality: "hq",
    coverage: "full",
    title: overrides.id,
    sourceResolutionM: 0.25,
    geographicReliability: "authoritative",
    providerStability: "stable",
    redistribution: "allowed",
    license: "CC BY 4.0",
    attribution: "Fixture",
    sourceUrl: `https://example.test/${overrides.id}`,
    ...overrides,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function registryFetcher(urls: string[]): TrackImageryFetcher {
  return (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("openaerialmap.org/meta")) {
      return json({
        meta: { license: "CC-BY 4.0" },
        results: [
          {
            _id: "5a00c655bac48e5b1cf76247",
            uuid: "https://example.test/oam.tif",
            title: "OAM fixture",
            gsd: 0.2,
            acquisition_start: "2025-01-02T00:00:00Z",
            bbox: [-180, -90, 180, 90],
            properties: { license: "CC-BY 4.0", tms: "https://tiles.openaerialmap.org/test/{z}/{x}/{y}.png" },
          },
        ],
      });
    }
    if (url.includes("service.pdok.nl") && url.includes("GetCapabilities")) {
      const layers = Array.from({ length: 11 }, (_, index) => {
        const year = 2026 - index;
        const detail = year >= 2021 ? "orthoHR" : "ortho25";
        return `<Layer><Name>${year}_${detail}</Name></Layer>`;
      }).join("");
      return new Response(`<WMS_Capabilities>${layers}<Layer><Name>2026_ortho25</Name></Layer></WMS_Capabilities>`, { headers: { "Content-Type": "application/xml" } });
    }
    if (url.endsWith("/arcgis/rest/services/IMAGERIE?f=json")) {
      return json({
        services: ["ORTHO_2023_ETE", "ORTHO_2022_ETE", "ORTHO_2022_PRINTEMPS", "ORTHO_1978_1990", "ORTHO_1971"].map((service) => ({
          name: `IMAGERIE/${service}`,
          type: "MapServer",
        })),
      });
    }
    if (url.includes("geoservices.wallonie.be/arcgis/rest/services/IMAGERIE/") && url.endsWith("/MapServer/0?f=json")) {
      const service = /\/IMAGERIE\/([^/]+)\/MapServer/.exec(url)?.[1];
      const descriptions: Record<string, string> = {
        ORTHO_2023_ETE: "Imagerie couvrant le territoire wallon à une résolution de 25 cm.",
        ORTHO_2022_ETE: "Imagerie couvrant le territoire wallon à une résolution de 25 cm.",
        ORTHO_2022_PRINTEMPS: "Imagerie couvrant le territoire wallon à une résolution de 25 cm.",
        ORTHO_1978_1990: "Imagerie couvrant une partie du territoire wallon à une résolution de 50 cm.",
        ORTHO_1971: "Imagerie couvrant l'entièreté du territoire wallon à une résolution de 1 m.",
      };
      if (!service || !descriptions[service]) throw new Error(`Unexpected Wallonia metadata request: ${url}`);
      return json({ type: "Raster Layer", description: descriptions[service] });
    }
    if (url.includes("planetarycomputer.microsoft.com/api/stac/v1/search")) {
      return json({
        features: [
          {
            id: "S2A_fixture",
            collection: "sentinel-2-l2a",
            bbox: [-180, -90, 180, 90],
            properties: { datetime: "2026-01-02T00:00:00Z", "eo:cloud_cover": 2 },
            assets: { visual: { href: "https://example.test/visual.tif" } },
          },
        ],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }) as TrackImageryFetcher;
}

test("filters national providers by resolved location before network calls", () => {
  expect(trackImageryProvidersForLocation(spa, spaBounds).map((provider) => provider.id)).toEqual(["wallonia-spw", "openaerialmap", "sentinel-2-l2a"]);
  expect(trackImageryProvidersForLocation(zandvoort, zandvoortBounds).map((provider) => provider.id)).toEqual(["pdok-netherlands-rgb", "openaerialmap", "sentinel-2-l2a"]);
  expect(trackImageryProvidersForLocation(unitedStates, usBounds).map((provider) => provider.id)).toEqual(["usgs-naip", "openaerialmap", "sentinel-2-l2a"]);
  expect(trackImageryProvidersForLocation(global, globalBounds).map((provider) => provider.id)).toEqual(["openaerialmap", "sentinel-2-l2a"]);
});

test("Spa groups ranked imagery options under their display sources", async () => {
  const urls: string[] = [];
  const result = await searchTrackImageryProviders(spaBounds, spa, registryFetcher(urls));
  const candidates = result.sources.flatMap((source) => source.candidates);
  expect(candidates.some((item) => item.id === "wallonia-spw:ortho_2023_ete")).toBe(true);
  expect(candidates.some((item) => item.id === "wallonia-spw:ortho_1971")).toBe(true);
  expect(candidates.some((item) => item.provider === "openaerialmap")).toBe(true);
  expect(urls.some((url) => url.includes("nationalmap.gov"))).toBe(false);
  expect(urls.some((url) => url.includes("pdok.nl"))).toBe(false);
  expect(candidates.find((item) => item.id === "openaerialmap:5a00c655bac48e5b1cf76247")?.sourceResolutionM).toBe(0.2);
  expect(candidates.find((item) => item.id === "wallonia-spw:ortho_2023_ete")?.sourceResolutionM).toBe(0.25);
  expect(result.sources[0]).toMatchObject({ id: "openaerialmap", name: "OpenAerialMap" });
});

test("location filter includes PDOK in Zandvoort, NAIP in US, and OAM plus Sentinel globally", () => {
  expect(trackImageryProvidersForLocation(zandvoort, zandvoortBounds).map((provider) => provider.id)).toContain("pdok-netherlands-rgb");
  expect(trackImageryProvidersForLocation(unitedStates, usBounds).map((provider) => provider.id)).toContain("usgs-naip");
  expect(trackImageryProvidersForLocation(global, globalBounds).map((provider) => provider.id)).toEqual(["openaerialmap", "sentinel-2-l2a"]);
  expect(TRACK_IMAGERY_PROVIDERS.map((provider) => provider.id)).toEqual(["usgs-naip", "wallonia-spw", "pdok-netherlands-rgb", "openaerialmap", "sentinel-2-l2a"]);
});

test("global search groups reusable OAM HQ and Sentinel context options", async () => {
  const result = await searchTrackImageryProviders(globalBounds, global, registryFetcher([]));
  expect(result.sources.map((source) => [source.id, source.name])).toEqual([
    ["openaerialmap", "OpenAerialMap"],
    ["sentinel-2-l2a", "Sentinel-2 L2A true color"],
  ]);
  expect(result.sources[0]?.candidates[0]?.quality).toBe("hq");
  expect(result.sources[1]?.candidates[0]).toMatchObject({ quality: "context", sourceResolutionM: 10, coverage: "full" });
});

test("PDOK discovers best annual layers from live WMS capabilities", async () => {
  const pdok = TRACK_IMAGERY_PROVIDERS.find((provider) => provider.id === "pdok-netherlands-rgb");
  expect(pdok).toBeDefined();
  const candidates = await pdok!.search({ bounds: zandvoortBounds, location: zandvoort, fetcher: registryFetcher([]) });
  expect(candidates).toHaveLength(11);
  expect(candidates[0]).toMatchObject({ id: "pdok-netherlands-rgb:2026-orthohr", sourceResolutionM: 0.08, quality: "hq" });
  expect(candidates.at(-1)).toMatchObject({ id: "pdok-netherlands-rgb:2016-ortho25", sourceResolutionM: 0.25, capturedAt: "2016-01-01/2016-12-31" });
});

test("NAIP preserves exact geographic bounds across chunked exports", async () => {
  let exportUrl = "";
  const fetcher = (async (input: string | URL | Request) => {
    exportUrl = String(input);
    return new Response(Uint8Array.from([1, 2, 3]).buffer, { headers: { "Content-Type": "image/jpeg" } });
  }) as TrackImageryFetcher;
  await naipProvider.fetch(
    {
      candidate: candidate({
        id: "usgs-naip:latest",
        provider: "usgs-naip",
        sourceResolutionM: 0.3,
        license: "Public domain",
        attribution: "USDA NAIP",
      }),
    },
    usBounds,
    512,
    256,
    fetcher,
  );
  expect(new URL(exportUrl).searchParams.get("adjustAspectRatio")).toBe("false");
});

test("NAIP exposes only full-coverage historical vintages and renders their source mosaic", async () => {
  const items = [
    {
      id: "fl_2023_west",
      collection: "naip",
      bbox: [-81.02, 28.98, -81, 29.02],
      properties: { datetime: "2023-01-17T16:00:00Z", gsd: 0.3, "naip:year": "2023" },
      assets: { image: { href: "https://example.test/2023-west.tif" } },
    },
    {
      id: "fl_2023_east",
      collection: "naip",
      bbox: [-81, 28.98, -80.98, 29.02],
      properties: { datetime: "2023-01-17T16:00:00Z", gsd: 0.3, "naip:year": "2023" },
      assets: { image: { href: "https://example.test/2023-east.tif" } },
    },
    {
      id: "fl_2021_partial",
      collection: "naip",
      bbox: [-81.02, 28.98, -81, 29.02],
      properties: { datetime: "2021-11-30T16:00:00Z", gsd: 0.6, "naip:year": "2021" },
      assets: { image: { href: "https://example.test/2021-west.tif" } },
    },
  ];
  const dataUrls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "imagery.nationalmap.gov" && url.pathname.endsWith("/query")) return json({ features: [] });
    if (url.hostname === "planetarycomputer.microsoft.com" && url.pathname.endsWith("/search")) return json({ features: items });
    if (url.hostname === "planetarycomputer.microsoft.com" && url.pathname.includes("/api/data/v1/item/bbox/")) {
      dataUrls.push(url.href);
      const dimensions = /\/(\d+)x(\d+)\.webp$/.exec(url.pathname);
      if (!dimensions) throw new Error(`Missing render dimensions in ${url}`);
      const bytes = await sharp({
        create: { width: Number(dimensions[1]), height: Number(dimensions[2]), channels: 3, background: { r: 60, g: 90, b: 120 } },
      })
        .webp()
        .toBuffer();
      return new Response(Uint8Array.from(bytes).buffer, { headers: { "Content-Type": "image/webp" } });
    }
    throw new Error(`Unexpected NAIP URL ${url}`);
  }) as TrackImageryFetcher;

  const candidates = await naipProvider.search({ bounds: usBounds, location: unitedStates, fetcher });
  expect(candidates.map(({ id }) => id)).toEqual(["usgs-naip:2023"]);
  expect(candidates[0]).toMatchObject({ capturedAt: "2023-01-17", sourceResolutionM: 0.3, redistribution: "allowed" });

  const resolved = await naipProvider.resolve("usgs-naip:2023", { bounds: usBounds, location: unitedStates, fetcher });
  const rendered = await naipProvider.fetch(resolved, usBounds, 64, 32, fetcher);
  expect(await sharp(rendered).metadata()).toMatchObject({ format: "png", width: 64, height: 32, hasAlpha: true });
  expect(dataUrls).toHaveLength(2);
  expect(dataUrls.every((url) => url.includes("collection=naip") && url.includes("assets=image"))).toBe(true);
});

test("Wallonia discovers full-coverage seasonal and historical orthophotos", async () => {
  const provider = TRACK_IMAGERY_PROVIDERS.find((candidateProvider) => candidateProvider.id === "wallonia-spw");
  expect(provider).toBeDefined();
  const candidates = await provider!.search({ bounds: spaBounds, location: spa, fetcher: registryFetcher([]) });
  expect(candidates).toHaveLength(4);
  expect(candidates.slice(0, 3).map(({ id }) => id)).toEqual(["wallonia-spw:ortho_2023_ete", "wallonia-spw:ortho_2022_ete", "wallonia-spw:ortho_2022_printemps"]);
  expect(candidates.at(-1)).toMatchObject({ id: "wallonia-spw:ortho_1971", sourceResolutionM: 1, capturedAt: "1971-01-01/1971-12-31" });
});

test("ranking prioritizes coverage, quality, resolution, reliability, recency, cloud, stability, then provider and id", () => {
  const ranked = rankTrackImageryCandidates([
    candidate({
      id: "z-community",
      coverage: "full",
      quality: "hq",
      sourceResolutionM: 0.2,
      geographicReliability: "community",
      capturedAt: "2026-01-01",
      cloudCoverPercent: 1,
      providerStability: "stable",
      provider: "z",
    }),
    candidate({
      id: "a-authoritative",
      coverage: "full",
      quality: "hq",
      sourceResolutionM: 0.2,
      geographicReliability: "authoritative",
      capturedAt: "2025-01-01",
      cloudCoverPercent: 50,
      providerStability: "opportunistic",
      provider: "a",
    }),
    candidate({ id: "partial-best", coverage: "partial", sourceResolutionM: 0.01 }),
    candidate({ id: "context", quality: "context", sourceResolutionM: 0.01 }),
    candidate({ id: "coarse", sourceResolutionM: 0.6 }),
    candidate({ id: "newer", sourceResolutionM: 0.2, capturedAt: "2026-02-01" }),
    candidate({ id: "clearer", sourceResolutionM: 0.2, capturedAt: "2026-02-01", cloudCoverPercent: 0 }),
    candidate({ id: "authoritative-stable", sourceResolutionM: 0.2, capturedAt: "2026-02-01", cloudCoverPercent: 0, providerStability: "authoritative" }),
    candidate({ id: "tie-b", provider: "tie", sourceResolutionM: 0.2, capturedAt: "2026-02-01", cloudCoverPercent: 0, providerStability: "authoritative" }),
    candidate({ id: "tie-a", provider: "tie", sourceResolutionM: 0.2, capturedAt: "2026-02-01", cloudCoverPercent: 0, providerStability: "authoritative" }),
  ]);
  expect(ranked.map((item) => item.id)).toEqual(["authoritative-stable", "tie-a", "tie-b", "clearer", "newer", "a-authoritative", "z-community", "coarse", "context", "partial-best"]);
});

test("Sentinel resolves L2A context and fetches visual data through bbox endpoint at 10m", async () => {
  const candidateId = "sentinel-2-l2a:S2A_fixture";
  const urls: string[] = [];
  const fetcher = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/stac/v1/collections/sentinel-2-l2a/items/")) {
      return json({
        id: "S2A_fixture",
        collection: "sentinel-2-l2a",
        bbox: [-1, -1, 1, 1],
        properties: { datetime: "2026-01-02T00:00:00Z", "eo:cloud_cover": 2 },
        assets: { visual: { href: "https://example.test/visual.tif" } },
      });
    }
    if (url.includes("/api/data/v1/item/bbox/")) return new Response(Uint8Array.from([1, 2, 3]).buffer, { headers: { "Content-Type": "image/webp" } });
    throw new Error(`Unexpected Sentinel URL ${url}`);
  }) as TrackImageryFetcher;
  const resolved = await sentinel2Provider.resolve(candidateId, { bounds: globalBounds, location: global, fetcher });
  expect(resolved.candidate).toMatchObject({ id: candidateId, quality: "context", sourceResolutionM: 10, provider: "sentinel-2-l2a" });
  const bytes = await sentinel2Provider.fetch(resolved, globalBounds, 64, 32, fetcher);
  expect(bytes).toEqual(Uint8Array.from([1, 2, 3]));
  const dataUrl = urls.find((url) => url.includes("/api/data/v1/item/bbox/"));
  expect(dataUrl).toContain("/api/data/v1/item/bbox/-0.01,0.01,0.01,0.03/64x32.webp");
  expect(dataUrl).toContain("collection=sentinel-2-l2a");
  expect(dataUrl).toContain("assets=visual");
  expect(urls.some((url) => url.toLowerCase().includes("nasa") || url.toLowerCase().includes("hls"))).toBe(false);
});

test("retries transient provider responses during package generation", async () => {
  let calls = 0;
  const fetcher = (async (_input: string | URL | Request) => {
    calls += 1;
    return calls === 1 ? new Response("temporary gateway failure", { status: 502, headers: { "Retry-After": "0" } }) : new Response("ok");
  }) as TrackImageryFetcher;
  const response = await request("https://example.test/imagery", fetcher);
  expect(await response.text()).toBe("ok");
  expect(calls).toBe(2);
});
