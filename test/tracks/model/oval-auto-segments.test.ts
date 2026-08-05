import { describe, expect, test } from "bun:test";
import { autoTrackSegments } from "../../../shared/racing/tracks/curation/generate";

function ovalOutline(): { x: number; z: number }[] {
  return Array.from({ length: 512 }, (_, index) => {
    const angle = (index / 512) * Math.PI * 2;
    return { x: Math.cos(angle) * 500, z: Math.sin(angle) * 150 };
  });
}

function figureEightOutline(): { x: number; z: number }[] {
  return Array.from({ length: 512 }, (_, index) => {
    const angle = (index / 512) * Math.PI * 2;
    return { x: Math.sin(angle) * 500, z: Math.sin(angle * 2) * 200 };
  });
}

function stadiumOutline(): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  for (let index = 0; index < 64; index++) points.push({ x: (index / 64) * 500, z: -100 });
  for (let index = 0; index < 128; index++) {
    const angle = -Math.PI / 2 + (index / 127) * Math.PI;
    points.push({ x: 500 + Math.cos(angle) * 100, z: Math.sin(angle) * 100 });
  }
  for (let index = 0; index < 128; index++) points.push({ x: 500 - (index / 127) * 1000, z: 100 });
  for (let index = 0; index < 128; index++) {
    const angle = Math.PI / 2 + (index / 127) * Math.PI;
    points.push({ x: -500 + Math.cos(angle) * 100, z: Math.sin(angle) * 100 });
  }
  for (let index = 0; index < 64; index++) points.push({ x: -500 + (index / 63) * 500, z: -100 });
  return points;
}

describe("automatic oval segments", () => {
  test("uses standard four-turn oval order and terminology", () => {
    const result = autoTrackSegments(ovalOutline(), { fourTurnOval: { direction: "left" } });
    expect(result.cornerCount).toBe(4);
    expect(result.segments.map((segment) => ({
      type: segment.type,
      name: segment.name,
      number: segment.number,
      direction: segment.direction,
      group: segment.group,
    }))).toEqual([
      { type: "straight", name: "Frontstretch", number: undefined, direction: undefined, group: "Frontstretch" },
      { type: "corner", name: "", number: 1, direction: "left", group: undefined },
      { type: "corner", name: "", number: 2, direction: "left", group: undefined },
      { type: "straight", name: "Backstretch", number: undefined, direction: undefined, group: undefined },
      { type: "corner", name: "", number: 3, direction: "left", group: undefined },
      { type: "corner", name: "", number: 4, direction: "left", group: undefined },
      { type: "straight", name: "Frontstretch", number: undefined, direction: undefined, group: "Frontstretch" },
    ]);
    expect(result.segments[0].startFrac).toBe(0);
    expect(result.segments.at(-1)?.endFrac).toBe(1);
    for (let index = 1; index < result.segments.length; index++) {
      expect(result.segments[index].startFrac).toBe(
        result.segments[index - 1].endFrac,
      );
    }
  });

  test("supports explicit clockwise oval exceptions", () => {
    const result = autoTrackSegments(ovalOutline(), { fourTurnOval: { direction: "right" } });
    expect(result.segments.filter((segment) => segment.type === "corner").every((segment) => segment.direction === "right")).toBe(true);
  });

  test("leaves mixed-direction layouts on generic detection", () => {
    const result = autoTrackSegments(figureEightOutline(), { fourTurnOval: { direction: "left" } });
    expect(result.cornerCount).not.toBe(4);
    expect(new Set(result.segments.filter((segment) => segment.type === "corner").map((segment) => segment.direction))).toEqual(new Set(["left", "right"]));
  });

  test("groups start/finish straight across lap boundary", () => {
    const result = autoTrackSegments(stadiumOutline());
    expect(result.segments[0]).toMatchObject({ type: "straight", name: "Start/Finish Straight", group: "Start/Finish Straight", startFrac: 0 });
    expect(result.segments.at(-1)).toMatchObject({ type: "straight", name: "Start/Finish Straight", group: "Start/Finish Straight", endFrac: 1 });
  });
});
