import type { GameId } from "@raceiq/shared/games/ids";

let notifier: ((gameId: GameId) => void) | undefined;

/** Application assembly supplies background AI scheduling; core owns DB writes. */
export function registerDriverProfileLapNotifier(callback: (gameId: GameId) => void): void {
  notifier = callback;
}

export function notifyDriverProfileLap(gameId: GameId): void {
  if (!notifier) throw new Error("Driver profile lap notifier is not initialized");
  notifier(gameId);
}
