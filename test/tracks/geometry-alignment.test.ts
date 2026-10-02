import { expect, test } from "bun:test";
import { applyAlignment, computeAlignment } from "../../shared/racing/tracks/geometry/points";

const segment = (start: { x: number; z: number }, end: { x: number; z: number }, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    x: start.x + (end.x - start.x) * index / count,
    z: start.z + (end.z - start.z) * index / count,
  }));

test("straight alignment resists displaced racing lines through corners", () => {
  const centerLine = [
    ...segment({ x: 0, z: 0 }, { x: 400, z: 0 }, 40),
    ...Array.from({ length: 24 }, (_, index) => ({
      x: 400 + 80 * Math.sin(Math.PI * index / 24),
      z: 80 - 80 * Math.cos(Math.PI * index / 24),
    })),
    ...segment({ x: 400, z: 160 }, { x: 0, z: 160 }, 40),
    ...Array.from({ length: 24 }, (_, index) => ({
      x: -80 * Math.sin(Math.PI * index / 24),
      z: 80 + 80 * Math.cos(Math.PI * index / 24),
    })),
    { x: 0, z: 0 },
  ];
  const lap = centerLine.map((point, index) => {
    const cornerIndex = index >= 40 && index < 64 ? index - 40 : index >= 104 && index < 128 ? index - 104 : null;
    return {
      x: point.x + 100,
      z: point.z - 50 + (cornerIndex === null ? 0 : 30 * Math.sin(Math.PI * cornerIndex / 24)),
    };
  });
  const transform = computeAlignment(centerLine, lap);
  expect(transform).not.toBeNull();
  for (const z of [0, 160]) {
    const aligned = applyAlignment({ x: 200, z }, transform!);
    expect(Math.abs(aligned.x - 300)).toBeLessThan(5);
    expect(Math.abs(aligned.z - (z - 50))).toBeLessThan(5);
  }
});
