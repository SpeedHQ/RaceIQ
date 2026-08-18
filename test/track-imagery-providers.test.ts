import { expect, test } from "bun:test";
import {
  TRACK_IMAGERY_PROVIDERS,
  rankTrackImageryCandidates,
  resolveTrackImageryProviderCandidate,
  searchTrackImageryProviders,
  trackImageryProvidersForLocation,
} from "../server/tracks/imagery-providers";
import { sentinel2Provider } from "../server/tracks/imagery-providers/sentinel2";
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

test("Spa searches Wallonia and OAM without irrelevant NAIP or PDOK requests", async () => {
  const urls: string[] = [];
  const result = await searchTrackImageryProviders(spaBounds, spa, registryFetcher(urls));
  expect(result.candidates.some((item) => item.id === "wallonia-spw:ortho-last")).toBe(true);
  expect(result.candidates.some((item) => item.provider === "openaerialmap")).toBe(true);
  expect(urls.some((url) => url.includes("nationalmap.gov"))).toBe(false);
  expect(urls.some((url) => url.includes("pdok.nl"))).toBe(false);
  expect(result.candidates.find((item) => item.id === "openaerialmap:5a00c655bac48e5b1cf76247")?.sourceResolutionM).toBe(0.2);
  expect(result.candidates.find((item) => item.id === "wallonia-spw:ortho-last")?.sourceResolutionM).toBe(0.25);
  expect(result.candidates[0]?.provider).toBe("openaerialmap");
});

test("location filter includes PDOK in Zandvoort, NAIP in US, and OAM plus Sentinel globally", () => {
  expect(trackImageryProvidersForLocation(zandvoort, zandvoortBounds).map((provider) => provider.id)).toContain("pdok-netherlands-rgb");
  expect(trackImageryProvidersForLocation(unitedStates, usBounds).map((provider) => provider.id)).toContain("usgs-naip");
  expect(trackImageryProvidersForLocation(global, globalBounds).map((provider) => provider.id)).toEqual(["openaerialmap", "sentinel-2-l2a"]);
  expect(TRACK_IMAGERY_PROVIDERS.map((provider) => provider.id)).toEqual(["usgs-naip", "wallonia-spw", "pdok-netherlands-rgb", "openaerialmap", "sentinel-2-l2a"]);
});

test("global search returns reusable OAM HQ and Sentinel context candidates", async () => {
  const result = await searchTrackImageryProviders(globalBounds, global, registryFetcher([]));
  expect(result.candidates.map((item) => item.provider)).toEqual(["openaerialmap", "sentinel-2-l2a"]);
  expect(result.candidates.find((item) => item.provider === "openaerialmap")?.quality).toBe("hq");
  expect(result.candidates.find((item) => item.provider === "sentinel-2-l2a")).toMatchObject({ quality: "context", sourceResolutionM: 10, coverage: "full" });
});

test("PDOK advertises 0.08m source detail while normalized source pipeline must clamp stored detail to 0.10m", async () => {
  const pdok = TRACK_IMAGERY_PROVIDERS.find((provider) => provider.id === "pdok-netherlands-rgb");
  expect(pdok).toBeDefined();
  const [candidateValue] = await pdok!.search({ bounds: zandvoortBounds, location: zandvoort, fetcher: registryFetcher([]) });
  expect(candidateValue).toMatchObject({ id: "pdok-netherlands-rgb:2026-orthohr", sourceResolutionM: 0.08, quality: "hq" });
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
