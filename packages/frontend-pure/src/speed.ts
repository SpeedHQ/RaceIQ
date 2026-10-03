export function convertSpeed(ms: number, unit: "mph" | "kmh"): number {
  return unit === "kmh" ? ms * 3.6 : ms * 2.23694;
}

export function convertDistance(meters: number, unit: "mph" | "kmh"): number {
  return unit === "kmh" ? meters / 1000 : meters / 1609.34;
}

export function speedLabel(unit: "mph" | "kmh"): string {
  return unit === "kmh" ? "km/h" : "mph";
}

export function distanceLabel(unit: "mph" | "kmh"): string {
  return unit === "kmh" ? "km" : "mi";
}
