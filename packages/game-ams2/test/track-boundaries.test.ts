import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAMS2TrackBoundaries, matchAMS2Layout, parseAMS2TrackSvg } from "@raceiq/game-ams2-metadata/track-boundaries";

const assets = resolve(import.meta.dir, "../assets");
const catalog = JSON.parse(readFileSync(resolve(assets, "tracks.json"), "utf8")) as {
  tracks: { layout: string; trackSvg: string; lengthM: number; slug: string }[];
};

test("all AMS2 SVG boundaries retain the extracted native coordinates and closed edges", () => {
  expect(catalog.tracks).toHaveLength(235);
  for (const track of catalog.tracks) {
    const svg = readFileSync(resolve(assets, track.trackSvg), "utf8");
    const boundaries = parseAMS2TrackSvg(svg);
    expect(boundaries, track.layout).not.toBeNull();
    const source = JSON.parse(readFileSync(resolve(assets, "tracks", `${track.slug}-boundaries.json`), "utf8"));
    for (const channel of ["leftEdge", "rightEdge", "centerLine"] as const) {
      const points = boundaries![channel]!;
      const original = source[channel];
      expect(points.slice(0, original.length), `${track.layout}/${channel}`).toEqual(original);
      expect(points.at(-1)).toEqual(points[0]);
    }
    expect(boundaries!.pitLane).toBeNull();
  }
});

test("the runtime loads the exact Indy and Cordoba SVG layouts", () => {
  for (const [id, layout] of [[165370945, "BrandsHatch_Indy"], [-1142444519, "Cordoba"]] as const) {
    const track = catalog.tracks.find(track => track.layout === layout)!;
    const expected = parseAMS2TrackSvg(readFileSync(resolve(assets, track.trackSvg), "utf8"));
    const actual = getAMS2TrackBoundaries(id);
    expect(actual).not.toBeNull();
    expect(actual).toEqual(expected);
    actual!.leftEdge[0]!.x += 100;
    expect(getAMS2TrackBoundaries(id)).toEqual(expected);
  }
});

test("SVG selection rejects unknown, ambiguous and wrong-length layouts", () => {
  const track = catalog.tracks.find(track => track.layout === "Cordoba")!;
  expect(matchAMS2Layout("Cordoba - Cordoba_International", track.lengthM, catalog.tracks)).toEqual(track);
  expect(matchAMS2Layout("Cordoba - Cordoba_International", 4055, catalog.tracks)).toBeNull();
  expect(matchAMS2Layout("Unknown", undefined, catalog.tracks)).toBeNull();
  expect(matchAMS2Layout("Cordoba", undefined, [track, track])).toBeNull();
});

test("unsupported or malformed SVG geometry stays unavailable", () => {
  const path = (id: string) => `<path id="${id}" d="M 0 0 L 10 0 L 0 10 Z" />`;
  const svg = `<svg>${path("left")}${path("right")}${path("center-line")}</svg>`;
  expect(parseAMS2TrackSvg(svg)).not.toBeNull();
  for (const invalid of [svg.replace(path("left"), ""), svg.replace("L 10 0", "L NaN 0"), svg.replace("L 10 0", "C 1 2 3 4 5 6"), svg.replace("<svg>", '<svg transform="translate(5)">'), svg.replace("</svg>", `${path("left")}</svg>`)]) {
    expect(parseAMS2TrackSvg(invalid)).toBeNull();
  }
});
