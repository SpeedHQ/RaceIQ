import { describe, expect, test } from "bun:test";
import { orientIRacingOvalMap } from "../../../server/games/iracing/track-map";
import {
  alignIRacingAutoSegmentsToTurnLabels,
  parseIRacingActiveSvg,
  parseIRacingPitRoadSvg,
  parseIRacingTurnLabels,
} from "../../../server/games/iracing/track-map-svg";
import {
  getIRacingSharedTrackName,
  getIRacingTrack,
} from "../../../shared/racing/tracks/catalogs/iracing";
import { loadLabelledSegments } from "../../../shared/racing/tracks/storage/meta";
import type { NamedSegment } from "../../../shared/racing/tracks/named-segments";

const activeSvg = `
  <svg viewBox="0 0 100 100">
    <path d="
      M0,0 L100,0 L100,100 L0,100 z
      M10,10 L10,90 L90,90 L90,10 z
    "/>
  </svg>
`;

const startFinishSvg = `
  <svg viewBox="0 0 100 100">
    <path d="M45,-4 L55,-4 L55,4 L45,4 z"/>
  </svg>
`;

const turnsSvg = `
  <svg viewBox="0 0 100 100">
    <text transform="matrix(1 0 0 1 92 10)">1</text>
    <text transform="matrix(1 0 0 1 92 90)">2</text>
    <text transform="matrix(1 0 0 1 50 106)">Main Straight</text>
  </svg>
`;

const pitRoadSvg = `
  <svg viewBox="0 0 100 100">
    <path d="M10,20 L20,20 L20,25 L10,25 z"/>
    <path d="M30,40 L40,40 L40,45 L30,45 z"/>
  </svg>
`;

function nearestIndex(
  points: { x: number; z: number }[],
  target: { x: number; z: number },
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index++) {
    const distance =
      (points[index].x - target.x) ** 2 +
      (points[index].z - target.z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

describe("iRacing official SVG track maps", () => {
  test("turns active ribbon into start-aligned ordered centerline", () => {
    const map = parseIRacingActiveSvg(
      activeSvg,
      startFinishSvg,
      turnsSvg,
      pitRoadSvg,
    );

    expect(map).not.toBeNull();
    expect(map!.points).toHaveLength(512);
    expect(map!.points[0].x).toBeCloseTo(-45, 0);
    expect(map!.points[0].z).toBeCloseTo(5, 0);
    expect(map!.labels.map((label) => label.text)).toEqual([
      "1",
      "2",
      "Main Straight",
    ]);
    expect(map!.pitRoad).toHaveLength(2);
    expect(map!.pitRoad[0][0]).toEqual({ x: -10, z: 20 });
    expect(map!.points).toEqual(
      parseIRacingActiveSvg(
        activeSvg,
        startFinishSvg,
        turnsSvg,
      )!.points,
    );

    const turn1 = map!.labels.find((label) => label.text === "1")!;
    const turn2 = map!.labels.find((label) => label.text === "2")!;
    expect(nearestIndex(map!.points, turn1)).toBeLessThan(
      nearestIndex(map!.points, turn2),
    );
  });

  test("keeps pit-road markings as separate filled contours", () => {
    const contours = parseIRacingPitRoadSvg(pitRoadSvg);
    expect(contours).toHaveLength(2);
    expect(contours.every((contour) => contour.length >= 4)).toBe(true);
  });

  test("normalizes oval traversal while retaining pit-road contours", () => {
    const map = {
      points: [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 1, z: 1 },
        { x: 0, z: 1 },
      ],
      labels: [],
      pitRoad: [[{ x: 2, z: 2 }, { x: 3, z: 2 }, { x: 3, z: 3 }]],
    };
    expect(orientIRacingOvalMap(map, "left").points).toEqual(map.points);
    expect(orientIRacingOvalMap(map, "right").points).toEqual([
      map.points[0],
      map.points[3],
      map.points[2],
      map.points[1],
    ]);
    expect(orientIRacingOvalMap(map, "right").pitRoad).toEqual(map.pitRoad);
  });

  test("reads matrix-positioned official turn names", () => {
    expect(parseIRacingTurnLabels(turnsSvg)).toContainEqual({
      text: "Main Straight",
      x: -50,
      z: 106,
    });
  });

  test("splits one detected corner at official turn labels", () => {
    const points = Array.from({ length: 101 }, (_, index) => ({ x: index, z: 0 }));
    const segments: NamedSegment[] = [
      { type: "straight", name: "", startFrac: 0, endFrac: 0.2 },
      { type: "corner", name: "T1", direction: "left", startFrac: 0.2, endFrac: 0.8 },
      { type: "straight", name: "", startFrac: 0.8, endFrac: 1 },
    ];

    const aligned = alignIRacingAutoSegmentsToTurnLabels(segments, points, [
      { text: "3", x: 30, z: 5 },
      { text: "4", x: 70, z: 5 },
    ]);

    expect(aligned.map(({ type, name, number, startFrac, endFrac }) => ({
      type,
      name,
      number,
      startFrac,
      endFrac,
    }))).toEqual([
      { type: "straight", name: "", number: undefined, startFrac: 0, endFrac: 0.2 },
      { type: "corner", name: "T3", number: 3, startFrac: 0.2, endFrac: 0.5 },
      { type: "corner", name: "T4", number: 4, startFrac: 0.5, endFrac: 0.8 },
      { type: "straight", name: "", number: undefined, startFrac: 0.8, endFrac: 1 },
    ]);
  });

  test("keeps Lime Rock layouts exact and uses curated names only for exact aliases", () => {
    expect(getIRacingSharedTrackName(352)).toBe("lime-rock");
    expect(getIRacingSharedTrackName(353)).toBeUndefined();
    expect(getIRacingTrack(352)?.mapUrl).toContain(
      "352-limerock-2019-classic",
    );
    expect(getIRacingTrack(353)?.mapUrl).toContain(
      "353-limerock-2019-gp",
    );

    const roadAmerica = loadLabelledSegments("road-america", "iracing");
    expect(roadAmerica.some((segment) => segment.name === "The Kink")).toBe(
      true,
    );
    expect(
      roadAmerica.some((segment) => segment.name === "Canada Corner"),
    ).toBe(true);
  });
});
