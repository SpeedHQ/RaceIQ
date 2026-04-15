import { describe, test, expect } from "bun:test";
import { getAcEvoCarByDisplayName, getAcEvoCarName } from "../shared/ac-evo-car-data";

describe("AC Evo car lookup", () => {
  test("resolves a CSV-listed car to its real ordinal", () => {
    const car = getAcEvoCarByDisplayName("Porsche 992 GT3 R");
    expect(car).toBeDefined();
    expect(car!.id).toBe(53);
    expect(car!.class).toBe("GT3");
  });

  test("returns undefined for a car not in cars.csv", () => {
    const car = getAcEvoCarByDisplayName("Definitely Not A Real Car __TEST__");
    expect(car).toBeUndefined();
  });

  test("getAcEvoCarName falls back to `Car #N` for unknown ordinals", () => {
    expect(getAcEvoCarName(999999)).toBe("Car #999999");
  });
});
