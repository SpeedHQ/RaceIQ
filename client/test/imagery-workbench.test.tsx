import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrackImageryCandidate, TrackImageryOutputBudget, TrackImagerySourceSearchGroup } from "../../shared/racing/tracks/imagery";
import { ImageryCandidateList } from "../src/components/dev/imagery/ImageryCandidatePanel";
import { ImageryImportEstimate } from "../src/components/dev/imagery/ImageryImportEstimate";

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

  const markup = renderToStaticMarkup(<ImageryCandidateList sources={sources} selectedCandidateId="sentinel-2-l2a:new" onSelect={() => undefined} />);

  expect(markup).toContain("Sentinel-2 L2A true color");
  expect(markup).toContain("2 images");
  expect(markup).toContain("OpenAerialMap");
  expect(markup).toContain("1 image");
  expect(markup).toContain("Latest Sentinel image");
  expect(markup).toContain("Earlier Sentinel image");
  expect(markup).toMatch(/aria-pressed="true"[^>]*>.*Selected/s);
});

test("calibration output budget shows complete pack size and processing limits", () => {
  const budget: TrackImageryOutputBudget = {
    width: 47_104,
    height: 46_915,
    totalPixels: 2_209_884_160,
    tileSize: 512,
    columns: 92,
    rows: 92,
    totalTiles: 8_464,
    sourceChunks: 144,
    resolutionM: 0.1,
    estimatedUncompressedBytes: 8_839_536_640,
    estimatedPackBytes: { minimum: 1_400_000_000, maximum: 3_800_000_000 },
    estimatedJobDurationMs: 1_200_000,
    availableDiskBytes: 20_000_000_000,
    requiredDiskBytes: 8_700_000_000,
    maximumJobDurationMs: 1_800_000,
    maximumConcurrency: 1,
    safe: false,
    overrideActive: false,
    problems: ["Output has 2,209,884,160 pixels; maximum is 500,000,000"],
  };

  const markup = renderToStaticMarkup(<ImageryImportEstimate budget={budget} />);
  expect(markup).toContain("Estimated output: 8,464 tiles, approximately 1.40 GB–3.80 GB");
  expect(markup).toContain("47,104 × 46,915 px");
  expect(markup).toContain("Uncompressed work 8.84 GB");
  expect(markup).toContain("disk available 20.0 GB");
  expect(markup).toContain("Job limit 30 min · 1 concurrent import");
  expect(markup).toContain("Output has 2,209,884,160 pixels; maximum is 500,000,000");
});
