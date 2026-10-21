/** Practice and LMU test days have timing ranks, not race result positions. */
export function isPracticeSession(type: string | null | undefined): boolean {
  const normalized = type?.trim().toLowerCase();
  return normalized === "test-day" || normalized?.startsWith("practice") === true;
}
