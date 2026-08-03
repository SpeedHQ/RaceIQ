import { describe, expect, test } from "bun:test";
import {
  parseIRacingActiveSvg,
  parseIRacingTurnLabels,
} from "../server/games/iracing/track-map-svg";
import { getIRacingSharedTrackName,
getIRacingTrack, } from "../shared/track/catalogs/iracing"
import { loadLabelledSegments } from "../shared/track/storage/meta";

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
  test("turns the active ribbon into a start-aligned ordered centerline", () => {
    const map = parseIRacingActiveSvg(
      activeSvg,
      startFinishSvg,
      turnsSvg,
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

    const turn1 = map!.labels.find((label) => label.text === "1")!;
    const turn2 = map!.labels.find((label) => label.text === "2")!;
    expect(nearestIndex(map!.points, turn1)).toBeLessThan(
      nearestIndex(map!.points, turn2),
    );
  });

  test("reads matrix-positioned official turn names", () => {
    expect(parseIRacingTurnLabels(turnsSvg)).toContainEqual({
      text: "Main Straight",
      x: -50,
      z: 106,
    });
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

    const roadAmerica = loadLabelledSegments(
      "road-america",
      "iracing",
    );
    expect(roadAmerica.some((segment) => segment.name === "The Kink")).toBe(
      true,
    );
    expect(
      roadAmerica.some((segment) => segment.name === "Canada Corner"),
    ).toBe(true);
  });
});
