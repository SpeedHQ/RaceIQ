export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9 / 5) + 32;
}

export function convertTemp(f: number, unit: "F" | "C"): number {
  return unit === "C" ? fahrenheitToCelsius(f) : f;
}
