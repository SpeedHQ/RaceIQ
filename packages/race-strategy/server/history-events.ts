import type { GameId } from "@raceiq/shared/games/ids";
import type { StrategyHistoryUpdatedMessage } from "@raceiq/shared/racing/live/strategy";

type Listener = (event: StrategyHistoryUpdatedMessage) => void;
const listeners = new Set<Listener>();
export function subscribeStrategyHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Called only after the evidence mutation transaction commits. */
export function publishStrategyHistory(gameId: GameId, driverKey: string, historyRevision: number): void {
  const event: StrategyHistoryUpdatedMessage = { type: "strategy-history-updated", gameId, driverKey, historyRevision };
  for (const listener of listeners) listener(event);
}
