import { createStore, useSelector, type StoreActionMap } from "@tanstack/react-store";
import type { GameId } from "../../../shared/games/ids";
import { telemetryStore } from "./telemetry";
const GAME_ROUTES: Record<string, string> = { "fm-2023": "/fm23", "f1-2025": "/f125", acc: "/acc", "ac-evo": "/ac-evo", iracing: "/iracing" };
export interface GameState { gameId: GameId | null }
export interface GameActions extends StoreActionMap { setGameId: (id: GameId | null) => void }
const initialGameState: GameState = { gameId: null };
export const gameStore = createStore(initialGameState, (store): GameActions => ({
  setGameId: (gameId) => { const prev = store.get().gameId; store.setState((state) => ({ ...state, gameId })); if (prev && gameId && prev !== gameId) telemetryStore.actions.setSessionLaps([]); },
}));
export function useGameStore<T>(selector: (state: GameState) => T): T { return useSelector(gameStore, selector, { compare: Object.is }); }
export function useGameId(): GameId | null { return useGameStore((s) => s.gameId); }
export function useRequiredGameId(): GameId { const stored = useGameStore((s) => s.gameId); if (stored) return stored; const path = typeof window !== "undefined" ? window.location.pathname : ""; for (const [id, prefix] of Object.entries(GAME_ROUTES)) if (path === prefix || path.startsWith(`${prefix}/`)) return id as GameId; throw new Error(`useRequiredGameId: no gameId in store and URL (${path}) does not match any game route`); }
export function useGameRoute(): string { const gameId = useGameId(); return gameId ? (GAME_ROUTES[gameId] ?? `/${gameId}`) : "/fm23"; }
export function getGameRoute(gameId: string): string { return GAME_ROUTES[gameId] ?? `/${gameId}`; }
