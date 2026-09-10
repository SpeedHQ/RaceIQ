export interface ChartRange {
  min: number;
  max: number;
}

export function clampVisibleRange(range: ChartRange, domain: ChartRange): ChartRange | null {
  const min = Math.max(domain.min, Math.min(domain.max, range.min));
  const max = Math.max(domain.min, Math.min(domain.max, range.max));
  if (!(max > min)) return null;
  return { min, max };
}
