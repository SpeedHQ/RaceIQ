export const IRACING_SECTOR_ORIGIN_EPSILON = 1e-6;

const warnedInvalidLayouts = new Set<string>();

export function startsAtIRacingSectorOrigin(
  value: number | undefined,
): boolean {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < IRACING_SECTOR_ORIGIN_EPSILON
  );
}

export function warnInvalidIRacingSectorLayout(
  starts: readonly number[],
): void {
  const values = starts.map(String).join(", ");
  const key = `${starts.length}:${values}`;
  if (warnedInvalidLayouts.has(key)) return;
  warnedInvalidLayouts.add(key);

  console.warn(
    `[iRacing] Ignoring malformed native sector layout (${values})`,
  );
}
