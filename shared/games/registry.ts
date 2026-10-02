import type { GameAdapter } from "./types";

const adapters = new Map<string, GameAdapter>();

export function registerGame(adapter: GameAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getGame(gameId: string): GameAdapter {
  const adapter = adapters.get(gameId);
  if (!adapter) throw new Error(`Unknown game: ${gameId}`);
  return adapter;
}

export function tryGetGame(gameId: string): GameAdapter | undefined {
  return adapters.get(gameId);
}

export function getAllGames(): GameAdapter[] {
  return [...adapters.values()];
}
