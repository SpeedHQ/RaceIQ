import { describe, expect, test } from "bun:test";
import { sortIRacingCars } from "../src/iracing-car-sort";

describe("iRacing car catalog sorting", () => {
  test("sorts legacy cars by actual name without changing display names", () => {
    const cars = [
      { id: "1", name: "[Legacy] Acura ARX-06" },
      { id: "2", name: "BMW M4 GT3" },
      { id: "3", name: "Audi R8" },
    ];
    expect(sortIRacingCars(cars).map((car) => car.name)).toEqual(["[Legacy] Acura ARX-06", "Audi R8", "BMW M4 GT3"]);
    expect(cars[0]?.name).toBe("[Legacy] Acura ARX-06");
  });

  test("only ignores a leading legacy prefix", () => {
    const cars = [
      { id: "1", name: "Mazda [Legacy] Cup" },
      { id: "2", name: "Audi R8" },
    ];
    expect(sortIRacingCars(cars).map((car) => car.name)).toEqual(["Audi R8", "Mazda [Legacy] Cup"]);
  });

  test("orders identical names by native numeric ID strings", () => {
    const cars = [{ id: "10", name: "Audi R8" }, { id: "2", name: "Audi R8" }];
    expect(sortIRacingCars(cars).map((car) => car.id)).toEqual(["2", "10"]);
  });
});
