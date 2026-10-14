import type { OnlineState } from "@raceiq/online/contracts";
import { isOnlineState } from "./raceiq-online";

const ONLINE_STATE_CACHE_KEY = "raceiq-online-state-v1";

export function readOnlineStateCache(): OnlineState | undefined {
  try {
    const raw = localStorage.getItem(ONLINE_STATE_CACHE_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!isOnlineState(value)) {
      localStorage.removeItem(ONLINE_STATE_CACHE_KEY);
      return undefined;
    }
    return value;
  } catch {
    try { localStorage.removeItem(ONLINE_STATE_CACHE_KEY); } catch { /* storage unavailable */ }
    return undefined;
  }
}

export function writeOnlineStateCache(state: OnlineState): void {
  try {
    if (isOnlineState(state)) localStorage.setItem(ONLINE_STATE_CACHE_KEY, JSON.stringify(state));
  } catch { /* display cache is optional */ }
}

export function clearOnlineStateCache(): void {
  try { localStorage.removeItem(ONLINE_STATE_CACHE_KEY); } catch { /* storage unavailable */ }
}
