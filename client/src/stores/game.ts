import { create } from "zustand";
import type { GameId } from "@shared/types";

/** Map gameId → route path segment. Derived from each adapter's routePrefix. */
const GAME_ROUTES: Record<string, string> = {
  "fm-2023": "/fm23",
  "f1-2025": "/f125",
  "acc": "/acc",
};

interface GameState {
  gameId: GameId | null;
  setGameId: (id: GameId | null) => void;
}

export const useGameStore = create<GameState>((set) => ({
  gameId: null,
  setGameId: (gameId) => set({ gameId }),
}));

export function useGameId(): GameId | null {
  return useGameStore((s) => s.gameId);
}

/** Strict variant — throws when called outside a game route. Use in
 *  components that only render inside a GameProvider layout.
 *
 *  The route-layout effect that calls `setGameId` runs *after* children
 *  mount, so on first render the store is null. Fall back to the URL path
 *  for that render; the store will hydrate the normal way on the next tick. */
export function useRequiredGameId(): GameId {
  const stored = useGameStore((s) => s.gameId);
  if (stored) return stored;
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  for (const [id, prefix] of Object.entries(GAME_ROUTES)) {
    if (path === prefix || path.startsWith(prefix + "/")) return id as GameId;
  }
  throw new Error(`useRequiredGameId: no gameId in store and URL (${path}) does not match any game route`);
}

/** Get the route path for the current game (e.g. "/fm23", "/f125", "/acc") */
export function useGameRoute(): string {
  const gameId = useGameId();
  return gameId ? (GAME_ROUTES[gameId] ?? `/${gameId}`) : "/fm23";
}

/** Get the route path for any gameId */
export function getGameRoute(gameId: string): string {
  return GAME_ROUTES[gameId] ?? `/${gameId}`;
}
