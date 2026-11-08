import { describe, test, expect } from "bun:test";
import {
  getAcEvoCarByDisplayName,
  getAcEvoCarName,
  injectDiscoveredAcEvoCars,
} from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";

describe("AC Evo native car lookup", () => {
  test("CSV metadata uses exact trimmed source display name as public id", () => {
    const car = getAcEvoCarByDisplayName("Porsche 992 GT3 R");
    expect(car).toBeDefined();
    expect(car!.id).toBe("Porsche 992 GT3 R");
    expect(car!.class).toBe("GT3");
    expect(getAcEvoCarName(car!.id)).toBe("Porsche 992 GT3 R");
  });

  test("unknown native car remains its own identity", () => {
    const name = "Definitely Not A Real Car __TEST__";
    injectDiscoveredAcEvoCars([{ id: name, name, model: "optional-model-slug" }]);
    expect(getAcEvoCarName(name)).toBe(name);
    expect(getAcEvoCarByDisplayName(name)?.id).toBe(name);
  });
});
