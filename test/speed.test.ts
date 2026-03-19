import { describe, test, expect } from "bun:test";
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../client/src/lib/speed";

describe("speed conversion", () => {
  test("convertSpeed m/s to mph", () => {
    expect(convertSpeed(1, "mph")).toBeCloseTo(2.23694, 3);
    expect(convertSpeed(10, "mph")).toBeCloseTo(22.3694, 2);
    expect(convertSpeed(0, "mph")).toBe(0);
  });

  test("convertSpeed m/s to km/h", () => {
    expect(convertSpeed(1, "kmh")).toBeCloseTo(3.6, 3);
    expect(convertSpeed(10, "kmh")).toBeCloseTo(36, 2);
  });

  test("convertDistance meters to miles", () => {
    expect(convertDistance(1609.34, "mph")).toBeCloseTo(1, 3);
    expect(convertDistance(0, "mph")).toBe(0);
  });

  test("convertDistance meters to km", () => {
    expect(convertDistance(1000, "kmh")).toBeCloseTo(1, 3);
    expect(convertDistance(5000, "kmh")).toBeCloseTo(5, 3);
  });

  test("speedLabel returns correct label", () => {
    expect(speedLabel("mph")).toBe("mph");
    expect(speedLabel("kmh")).toBe("km/h");
  });

  test("distanceLabel returns correct label", () => {
    expect(distanceLabel("mph")).toBe("mi");
    expect(distanceLabel("kmh")).toBe("km");
  });
});
