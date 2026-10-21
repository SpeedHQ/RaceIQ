import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogCarCard, filterCatalogCars, type IRacingCatalogCar } from "../src/components/iracing/IRacingCars";
import ams2Catalog from "../../packages/game-ams2-metadata/src/cars.json";

const car: IRacingCatalogCar = {
  id: "325487790", name: "Volkswagen Polo", shortName: "Polo", path: "", category: "TSICup",
  imageUrl: "", hasHeadlights: null, rainEnabled: null, hasMultipleDryTireTypes: null, searchTerms: "Polo",
};
function render(overrides: Partial<IRacingCatalogCar> = {}, unit: "metric" | "imperial" = "imperial") {
  return renderToStaticMarkup(createElement(CatalogCarCard, {car: {...car, ...overrides}, gameId: "ams2", unit}));
}
describe("catalog car cards", () => {
  test("search handles the AMS2 API shape without optional iRacing fields", () => {
    const cars = ams2Catalog.map(car => ({...car, path: "", category: car.classes.join(" / "), imageUrl: ""}));
    expect(filterCatalogCars(cars, "  POLO  ", null).map(car => car.name)).toContain("Volkswagen Polo");
    expect(filterCatalogCars(cars, "no matching car anywhere", null)).toEqual([]);
    const byClass = filterCatalogCars(cars, "gt3", null);
    expect(byClass.length).toBeGreaterThan(0);
    expect(byClass.every(car => car.category.toLowerCase().includes("gt3") || car.name.toLowerCase().includes("gt3"))).toBe(true);
    expect(filterCatalogCars(cars, "Polo", "GT3")).toEqual([]);
    expect(filterCatalogCars(cars, "", null)).toHaveLength(cars.length);
  });
  test("search preserves iRacing aliases and keywords and accepts explicit nulls", () => {
    expect(filterCatalogCars([{...car, name: "Test car", shortName: "Alias"}], "alias", null)).toHaveLength(1);
    expect(filterCatalogCars([{...car, name: "Test car", searchTerms: "Keyword"}], "keyword", null)).toHaveLength(1);
    expect(filterCatalogCars([{...car, shortName: null, searchTerms: null}], "no match", null)).toEqual([]);
  });
  test("missing pictures use a compact name and class card", () => {
    const html = render();
    expect(html).toContain("Volkswagen Polo");
    expect(html).toContain("TSICup");
    expect(html).not.toContain("h-40");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain(" hp");
    expect(html).not.toContain(" lb");
  });
  test("null, non-finite and unavailable specifications stay hidden", () => {
    for (const value of [null, NaN, Infinity, 0, -1]) {
      const html = render({hp: value, weightLb: value});
      expect(html).not.toContain(" hp");
      expect(html).not.toContain(" lb");
      expect(html).not.toContain("NaN");
    }
  });
  test("available specifications render independently in the selected units", () => {
    expect(render({hp: 500})).toContain("500 hp");
    expect(render({hp: 500})).not.toContain(" lb");
    expect(render({weightLb: 2000})).toContain("2,000 lb");
    expect(render({weightLb: 2000}, "metric")).toContain("907 kg");
  });
  test("cars with images keep their image area and specifications", () => {
    const html = render({imageUrl: "/car-images/example.jpg", hp: 500, weightLb: 2000});
    expect(html).toContain("h-40");
    expect(html).toContain('src="/car-images/example.jpg"');
    expect(html).toContain("500 hp · 2,000 lb");
  });
});
