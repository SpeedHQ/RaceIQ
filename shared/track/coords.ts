import { tryGetGame } from "@shared/games/registry";
import type { GameId } from "../games/ids";

export interface Pt {
  x: number;
  z: number;
}

/**
 * The telemetry pipeline negates PositionX for standard-xyz games (ACC, AC Evo)
 * so that telemetry coordinates match the display convention. Track outline and
 * boundary data arrives in raw game coordinates — these utilities flip them to
 * match the negated telemetry.
 *
 * Lives in shared/ (not client/) because test renderers must apply the exact
 * same flip the UI does before projecting; forking it produced mirrored SVGs.
 */
export function needsTrackFlip(gameId: GameId | null | undefined): boolean {
  if (!gameId) return false;
  return tryGetGame(gameId)?.coordSystem === "standard-xyz";
}

export function flipPoints<T extends Pt>(pts: T[]): T[] {
  return pts.map((p) => ({ ...p, x: -p.x }));
}

export function flipBoundaries<T extends { leftEdge: Pt[]; rightEdge: Pt[] }>(b: T): T {
  return {
    ...b,
    leftEdge: flipPoints(b.leftEdge),
    rightEdge: flipPoints(b.rightEdge),
    ...("centerLine" in b && b.centerLine ? { centerLine: flipPoints(b.centerLine as Pt[]) } : {}),
    ...("pitLane" in b && b.pitLane ? { pitLane: flipPoints(b.pitLane as Pt[]) } : {}),
  };
}
