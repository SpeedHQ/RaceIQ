import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackInfoPanel } from "../src/components/track/TrackInfoPanel";
import type { TrackInfo, TrackSectors } from "../src/components/track/types";

const track: TrackInfo = {
  ordinal: 12,
  name: "Daytona International Speedway",
  location: "Daytona Beach",
  country: "United States",
  variant: "Road Course",
  lengthKm: 5.73,
  hasOutline: true,
  createdAt: null,
};

const sectors: TrackSectors = {
  totalDist: 5_730,
  segments: [0.05, 0.25, 0.45, 0.65, 0.85].map((midpoint, index) => ({
    type: "corner" as const,
    name: `T${index + 1}`,
    number: index + 1,
    startFrac: midpoint - 0.01,
    endFrac: midpoint + 0.01,
    startIdx: index * 2,
    endIdx: index * 2 + 1,
  })),
};

describe("track sector boundaries", () => {
  test("renders all five source-defined iRacing sectors", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TrackInfoPanel track={track} sectors={sectors} sectorStarts={[0, 0.2, 0.4, 0.6, 0.8]} segSource="shared" lapCount={1} part="details" />
      </QueryClientProvider>,
    );

    for (const sector of ["S1", "S2", "S3", "S4", "S5"]) {
      expect(markup).toContain(`>${sector}<`);
    }
    expect(markup).not.toContain(">S6<");
    expect(markup).toContain("80.0% – 100.0%");
    expect(markup).toContain(">T5<");
  });
});
