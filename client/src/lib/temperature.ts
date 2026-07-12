export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}

/**
 * Convert a temperature value to the user's preferred unit.
 * @param value Raw temperature value
 * @param unit Target display unit
 * @param source Source unit of the raw value (Forza = "F", F1/ACC = "C")
 */
export function convertTemp(value: number, unit: "F" | "C", source: "F" | "C" = "F"): number {
  if (source === unit) return value;
  return source === "F" ? fahrenheitToCelsius(value) : celsiusToFahrenheit(value);
}
