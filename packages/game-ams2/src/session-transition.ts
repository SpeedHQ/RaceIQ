export function isAMS2StaleSessionTransition(
  previousSessionState: number | null,
  sessionState: number,
  raceState: number,
): boolean {
  return previousSessionState !== null && sessionState !== previousSessionState && raceState === 3;
}
