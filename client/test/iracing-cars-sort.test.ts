import { describe, expect, test } from "bun:test";
import { sortIRacingCars } from "../src/components/iracing/IRacingCars";
describe("iRacing car catalog sorting", () => {

  test("sorts legacy cars by actual name without changing display names", () => {
    const cars = [
      { ordinal: 1, name: "[Legacy] Acura ARX-06" },
      { ordinal: 2, name: "BMW M4 GT3" },
      { ordinal: 3, name: "Audi R8" },
    ];

    expect(sortIRacingCars(cars).map((car) => car.name)).toEqual([
      "[Legacy] Acura ARX-06",
      "Audi R8",
      "BMW M4 GT3",
    ]);
    expect(cars[0]?.name).toBe("[Legacy] Acura ARX-06");
  });

  test("only ignores a leading legacy prefix", () => {
    const cars = [
      { ordinal: 1, name: "Mazda [Legacy] Cup" },
      { ordinal: 2, name: "Audi R8" },
    ];

    expect(sortIRacingCars(cars).map((car) => car.name)).toEqual(["Audi R8", "Mazda [Legacy] Cup"]);
  });
});
