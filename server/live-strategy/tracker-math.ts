export function appendWithCap<T>(values: T[], value: T, maxLength: number): void {
  values.push(value);
  if (values.length > maxLength) {
    values.shift();
  }
}

export function linearInterpolate(start: number, end: number, fraction: number): number {
  return start + fraction * (end - start);
}

export function rollingAverage(values: number[], window: number): number {
  if (values.length === 0 || window <= 0) return 0;

  const start = Math.max(0, values.length - window);
  let total = 0;
  for (let i = start; i < values.length; i++) {
    total += values[i];
  }
  return total / (values.length - start);
}

export function lapsUntilThreshold(
  health: number,
  threshold: number,
  wearPerLap: number,
): number | null {
  if (!(wearPerLap > 0)) return null;

  const remainingWear = health - threshold;
  return remainingWear > 0
    ? Math.floor((remainingWear / wearPerLap) * 10) / 10
    : 0;
}

export function interpolateGrid(values: Float64Array, distance: number): number {
  if (values.length < 2) return -1;

  const index = Math.floor(distance);
  if (index < 0) return 0;
  if (index >= values.length - 1) return -1;

  const frac = distance - index;
  return linearInterpolate(values[index], values[index + 1], frac);
}

export function interpolateMonotonic(
  values: Float64Array,
  distances: Float64Array,
  x: number,
): number | null {
  const n = distances.length;
  if (values.length !== n || n < 2) return null;

  if (x <= distances[0]) return values[0];

  const lastIndex = n - 1;
  if (x >= distances[lastIndex]) return null;

  let lo = 0;
  let hi = lastIndex;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] <= x) lo = mid;
    else hi = mid;
  }

  const x0 = distances[lo];
  const x1 = distances[hi];
  const y0 = values[lo];
  const y1 = values[hi];

  const span = x1 - x0;
  const frac = (x - x0) / span;
  return linearInterpolate(y0, y1, frac);
}

export function sectorFromDistanceFraction(starts: readonly number[], fraction: number): number {
  let sector = 0;
  for (let index = 1; index < starts.length; index++) {
    if (fraction < starts[index]) break;
    sector = index;
  }
  return sector;
}
