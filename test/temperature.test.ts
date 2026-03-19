import { describe, test, expect } from "bun:test";
import { fahrenheitToCelsius, celsiusToFahrenheit, convertTemp } from "../client/src/lib/temperature";

describe("temperature conversion", () => {
  test("fahrenheitToCelsius converts known values", () => {
    expect(fahrenheitToCelsius(32)).toBeCloseTo(0);
    expect(fahrenheitToCelsius(212)).toBeCloseTo(100);
    expect(fahrenheitToCelsius(150)).toBeCloseTo(65.556, 2);
    expect(fahrenheitToCelsius(280)).toBeCloseTo(137.778, 2);
  });

  test("celsiusToFahrenheit converts known values", () => {
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32);
    expect(celsiusToFahrenheit(100)).toBeCloseTo(212);
    expect(celsiusToFahrenheit(65.556)).toBeCloseTo(150, 0);
  });

  test("convertTemp returns fahrenheit when unit is F", () => {
    expect(convertTemp(150, "F")).toBe(150);
    expect(convertTemp(220, "F")).toBe(220);
  });

  test("convertTemp converts to celsius when unit is C", () => {
    expect(convertTemp(150, "C")).toBeCloseTo(65.556, 2);
    expect(convertTemp(220, "C")).toBeCloseTo(104.444, 2);
  });

  test("round-trip conversion preserves value", () => {
    const original = 200;
    const celsius = fahrenheitToCelsius(original);
    const backToF = celsiusToFahrenheit(celsius);
    expect(backToF).toBeCloseTo(original, 5);
  });
});
