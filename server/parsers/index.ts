import type { TelemetryPacket } from "../../shared/types";
import { getAllServerGames, getRunningGame } from "../games/registry";

// Per-game parser state (e.g. F1StateAccumulator), keyed by game ID
const parserStates = new Map<string, unknown>();
let _statesInitialized = false;

function ensureStates() {
  if (_statesInitialized) return;
  _statesInitialized = true;
  for (const adapter of getAllServerGames()) {
    const state = adapter.createParserState();
    if (state != null) parserStates.set(adapter.id, state);
  }
}

let _seenUnknown = false;

// Cache the detected game to avoid getRunningGame() on every packet.
// Re-checked when canHandle fails (game might have changed).
let _cachedGame: ReturnType<typeof getRunningGame> = null;
let _cachedGameCheckedAt = 0;

/**
 * Parse a UDP packet using the running game's adapter.
 * Caches the detected game for speed — re-probes on miss or every 5 seconds.
 */
export function parsePacket(buf: Buffer): TelemetryPacket | null {
  ensureStates();

  // Use cached game if still valid
  if (_cachedGame && _cachedGame.canHandle(buf)) {
    return _cachedGame.tryParse(buf, parserStates.get(_cachedGame.id));
  }

  // Re-detect game (throttled to every 5s unless cache miss)
  const now = Date.now();
  if (now - _cachedGameCheckedAt > 5000 || !_cachedGame) {
    _cachedGameCheckedAt = now;
    _cachedGame = getRunningGame();
    if (_cachedGame && _cachedGame.canHandle(buf)) {
      return _cachedGame.tryParse(buf, parserStates.get(_cachedGame.id));
    }
  }

  // Fallback: probe all adapters
  for (const adapter of getAllServerGames()) {
    if (adapter.canHandle(buf)) {
      _cachedGame = adapter;
      return adapter.tryParse(buf, parserStates.get(adapter.id));
    }
  }

  // DEBUG: log once for packets that match no registered format
  if (!_seenUnknown) {
    _seenUnknown = true;
    const hex = buf.slice(0, 4).toString("hex").match(/../g)?.join(" ") ?? "";
    console.log(
      `[DEBUG UNKNOWN] Packet matches no registered game format: ` +
      `bufLen=${buf.length} first4bytes=[${hex}]`
    );
  }

  return null;
}

/** Get the game currently being detected from UDP packets. Returns null if no game detected yet. */
export function getCurrentDetectedGame(): ReturnType<typeof getRunningGame> {
  return _cachedGame;
}

export { parseForzaPacket } from "./forza";
export { F1StateAccumulator, parseF1Header } from "./f1-state";
