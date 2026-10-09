import { createContext, useContext } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import { routePrefixForGameId } from "../lib/game-routes";
import { create } from "zustand";
import { telemetryStore } from "./telemetry";

export interface GameState {
  gameId: GameId | null;
  setGameId: (id: GameId | null) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  gameId: null,
  setGameId: (gameId) => {
    const prev = get().gameId;
    if (prev === gameId) return;
    set({ gameId });
    // Clear stale session laps when switching between games
    if (prev && gameId && prev !== gameId) {
      telemetryStore.actions.setSessionLaps([]);
    }
  },
}));
type GameStoreApi = {
  get: () => GameState;
  setState: (state: GameState | Partial<GameState>) => void;
  subscribe: (listener: (state: GameState) => void) => () => void;
  actions: { setGameId: (gameId: GameId | null) => void };
};

const gameStoreApi = useGameStore as unknown as {
  getState: () => GameState;
  setState: (state: GameState | Partial<GameState>) => void;
  subscribe: (listener: (state: GameState) => void) => () => void;
};

export const gameStore: GameStoreApi = {
  get: () => gameStoreApi.getState(),
  setState: (state) => gameStoreApi.setState(state),
  subscribe: (listener) => gameStoreApi.subscribe(listener),
  actions: {
    setGameId: (gameId) => gameStoreApi.getState().setGameId(gameId),
  },
};

const STORE_GAME_CONTEXT_PATHS: Readonly<Record<string, true>> = {
  "/live": true,
  "/live/pit": true,
  "/portable/combo-1": true,
  "/portable/combo-2": true,
};

export function usesStoreGameContext(pathname: string): boolean {
  return STORE_GAME_CONTEXT_PATHS[pathname] === true;
}

const GameRouteContext = createContext<GameId | null | undefined>(undefined);

export const GameRouteProvider = GameRouteContext.Provider;

export function useGameId(): GameId | null {
  const routeGameId = useContext(GameRouteContext);
  const storedGameId = useGameStore((state) => state.gameId);
  return routeGameId === undefined ? storedGameId : routeGameId;
}

/** Strict variant — throws when called outside a game route. */
export function useRequiredGameId(): GameId {
  const gameId = useGameId();
  if (gameId) return gameId;
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  throw new Error(`useRequiredGameId: no gameId in store and URL (${path}) does not match any game route`);
}

/** Get the route path for the current game (e.g. "/fm23", "/f125", "/acc") */
export function useGameRoute(): string {
  const gameId = useGameId();
  return gameId ? `/${routePrefixForGameId(gameId) ?? gameId}` : "/fm23";
}

/** Get the route path for any gameId */
export function getGameRoute(gameId: string): string {
  return `/${routePrefixForGameId(gameId) ?? gameId}`;
}
