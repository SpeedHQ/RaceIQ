import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrackImageryCandidate, TrackImagerySourceSearchGroup } from "../../shared/racing/tracks/imagery";
import { TrackImagerySourceList } from "../src/components/dev/OpenTrackImageryPicker";

function candidate(id: string, provider: string, title: string, capturedAt: string, quality: TrackImageryCandidate["quality"]): TrackImageryCandidate {
  return {
    id,
    provider,
    quality,
    coverage: "full",
    title,
    capturedAt,
    sourceResolutionM: quality === "hq" ? 0.2 : 10,
    geographicReliability: quality === "hq" ? "community" : "satellite",
    cloudCoverPercent: quality === "hq" ? undefined : 3,
    providerStability: quality === "hq" ? "opportunistic" : "authoritative",
    redistribution: "allowed",
    license: "Reusable fixture license",
    attribution: "Fixture attribution",
    sourceUrl: `https://example.test/${id}`,
  };
}

test("imagery picker groups dated options by source and exposes selected option", () => {
  const sources: TrackImagerySourceSearchGroup[] = [
    {
      id: "sentinel-2-l2a",
      name: "Sentinel-2 L2A true color",
      candidates: [
        candidate("sentinel-2-l2a:new", "sentinel-2-l2a", "Latest Sentinel image", "2026-08-01T00:00:00Z", "context"),
        candidate("sentinel-2-l2a:old", "sentinel-2-l2a", "Earlier Sentinel image", "2026-07-15T00:00:00Z", "context"),
      ],
    },
    {
      id: "openaerialmap",
      name: "OpenAerialMap",
      candidates: [candidate("openaerialmap:one", "openaerialmap", "Community aerial survey", "2025-06-03T00:00:00Z", "hq")],
    },
  ];

  const markup = renderToStaticMarkup(<TrackImagerySourceList sources={sources} selectedCandidateId="sentinel-2-l2a:new" onSelect={() => undefined} />);

  expect(markup).toContain("Sentinel-2 L2A true color");
  expect(markup).toContain("2 images");
  expect(markup).toContain("OpenAerialMap");
  expect(markup).toContain("1 image");
  expect(markup).toContain("Latest Sentinel image");
  expect(markup).toContain("Earlier Sentinel image");
  expect(markup).toMatch(/aria-pressed="true"[^>]*>.*Selected/s);
});
