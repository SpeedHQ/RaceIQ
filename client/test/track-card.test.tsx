import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackCard } from "../src/components/track/TrackCard";
import type { TrackInfo } from "../src/components/track/types";

const track: TrackInfo = {
  ordinal: 26,
  name: "Daytona International Speedway",
  location: "Daytona Beach, Florida",
  country: "USA",
  variant: "Road Course",
  lengthKm: 5.729,
  hasOutline: true,
  mapUrl: "https://members-assets.iracing.com/public/track-maps/daytona/active.svg",
  createdAt: null,
};

describe("TrackCard map loading", () => {
  test("holds a neutral placeholder while generated geometry loads", () => {
    const markup = renderToStaticMarkup(<TrackCard track={track} onSelect={() => undefined} gameId="iracing" />);

    expect(markup).toContain('data-testid="track-map-loading-26"');
    expect(markup).not.toContain("active.svg");
    expect(markup).not.toContain("<img");
  });

  test("retains the static SVG for tracks without generated geometry", () => {
    const markup = renderToStaticMarkup(<TrackCard track={{ ...track, hasOutline: false }} onSelect={() => undefined} gameId="iracing" />);

    expect(markup).toContain("active.svg");
    expect(markup).toContain("<img");
  });
});
