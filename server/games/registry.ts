import { exec } from "child_process";
import type { ServerGameAdapter } from "./types";

const adapters: ServerGameAdapter[] = [];
const adapterMap = new Map<string, ServerGameAdapter>();
/** gameId → lowercase process names, built at registration time */
const processNameMap = new Map<string, string[]>();

export function registerServerGame(adapter: ServerGameAdapter): void {
  adapters.push(adapter);
  adapterMap.set(adapter.id, adapter);
  if (adapter.processNames?.length) {
    processNameMap.set(adapter.id, adapter.processNames.map((n) => n.toLowerCase()));
  }
}

export function getServerGame(gameId: string): ServerGameAdapter {
  const adapter = adapterMap.get(gameId);
  if (!adapter) throw new Error(`Unknown server game adapter: ${gameId}`);
  return adapter;
}

export function tryGetServerGame(gameId: string): ServerGameAdapter | undefined {
  return adapterMap.get(gameId);
}

/** Get all server adapters in registration order (used for packet detection priority). */
export function getAllServerGames(): readonly ServerGameAdapter[] {
  return adapters;
}

/**
 * Cached set of running process names (lowercase, no extension).
 * Refreshed asynchronously every 5s via a background timer so
 * callers never block the event loop waiting on `tasklist`.
 */
let _processNames: Set<string> = new Set();
let _refreshing = false;

function refreshProcessCache(): void {
  if (_refreshing) return;
  _refreshing = true;
  exec(
    'tasklist /FO CSV /NH',
    { encoding: "utf-8", timeout: 3000, windowsHide: true },
    (err, stdout) => {
      _refreshing = false;
      if (err || !stdout) return; // keep stale cache on error
      _processNames = new Set(
        stdout.split(/\r?\n/)
          .map((line) => line.match(/^"([^"]+)"/)?.[1]?.replace(/\.exe$/i, "").toLowerCase())
          .filter((n): n is string => !!n)
      );
    }
  );
}

// Seed immediately, then refresh every 5 seconds
refreshProcessCache();
setInterval(refreshProcessCache, 5000);

/** Check if a specific game's process is running. */
export function isGameRunning(gameId: string): boolean {
  const registeredNames = processNameMap.get(gameId);
  if (!registeredNames?.length) return false;
  return registeredNames.some((name) => {
    const bare = name.replace(/\.exe$/i, "");
    return _processNames.has(name) || _processNames.has(bare);
  });
}

/** Find which registered game is currently running. Returns null if none detected. */
export function getRunningGame(): ServerGameAdapter | null {
  if (_processNames.size === 0) return null;
  for (const adapter of adapters) {
    const names = processNameMap.get(adapter.id);
    if (names?.some((name) => {
      const bare = name.replace(/\.exe$/i, "");
      return _processNames.has(name) || _processNames.has(bare);
    })) return adapter;
  }
  return null;
}
