/**
 * Driver profile — scope selection, fetching, and the NDJSON stream.
 *
 * The layout itself lives in `DriverProfileView`, which takes fixed props. Split
 * that way so the awkward states (fingerprint with no plan, null axes, faults
 * with no measured cost) can be rendered on demand in Storybook and tests
 * instead of only when a live fetch happens to produce them.
 */

import { getGame } from "@shared/games/registry";
import { AlertTriangle, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/SearchSelect";
import type { DriverFingerprint } from "../../../../server/ai/driver-profile-aggregate";
import type { DriverProfileOutput } from "../../../../server/ai/schemas";
import { useLaps } from "../../hooks/queries";
import { useRequiredGameId } from "../../stores/game";
import { DriverProfileView } from "./DriverProfileView";

const GLOBAL_SCOPE = "__global__";

interface ProfileResponse {
  plan: DriverProfileOutput | null;
  fingerprint: DriverFingerprint | null;
  cached: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string };
  warnings?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Car+track combinations the driver actually has laps for, derived from the lap
 * list rather than a dedicated endpoint — the data is already loaded, and a
 * combination with no laps is one the profile could say nothing about anyway.
 *
 * The API treats a scope as car+track only when BOTH ordinals are set, so the
 * switcher never offers a car-without-track (or vice versa) option that would
 * silently resolve back to the global profile.
 */
function useScopeOptions(gameId: string) {
  const { data: laps = [] } = useLaps();
  return useMemo(() => {
    const game = getGame(gameId as Parameters<typeof getGame>[0]);
    const counts = new Map<string, { carOrdinal: number; trackOrdinal: number; n: number }>();
    for (const lap of laps) {
      if (lap.carOrdinal == null || lap.trackOrdinal == null) continue;
      const key = `${lap.carOrdinal}:${lap.trackOrdinal}`;
      const hit = counts.get(key);
      if (hit) hit.n++;
      else counts.set(key, { carOrdinal: lap.carOrdinal, trackOrdinal: lap.trackOrdinal, n: 1 });
    }
    const combos = [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([key, v]) => ({
        value: key,
        label: `${game.getCarName(v.carOrdinal)} · ${game.getTrackName(v.trackOrdinal)} (${v.n} lap${v.n === 1 ? "" : "s"})`,
      }));
    return [{ value: GLOBAL_SCOPE, label: `All laps · ${game.displayName}` }, ...combos];
  }, [laps, gameId]);
}

function parseScope(value: string): { carOrdinal?: number; trackOrdinal?: number } {
  if (value === GLOBAL_SCOPE) return {};
  const [car, track] = value.split(":").map(Number);
  return { carOrdinal: car, trackOrdinal: track };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DriverProfilePage() {
  const gameId = useRequiredGameId();
  const scopeOptions = useScopeOptions(gameId);
  const [scopeValue, setScopeValue] = useState(GLOBAL_SCOPE);
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = parseScope(scopeValue);

  const run = useCallback(
    async (opts: { regenerate?: boolean; cacheOnly?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (scope.carOrdinal !== undefined) params.set("carOrdinal", String(scope.carOrdinal));
        if (scope.trackOrdinal !== undefined) params.set("trackOrdinal", String(scope.trackOrdinal));
        if (opts.regenerate) params.set("regenerate", "true");
        if (opts.cacheOnly) params.set("cacheOnly", "true");

        const res = await fetch(`/api/drivers/profile?${params}`, {
          method: "POST",
          headers: { "X-Game-Id": gameId },
        });

        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/x-ndjson")) {
          const json = (await res.json()) as ProfileResponse;
          if (!res.ok) throw new Error(json.error ?? res.statusText);
          setData(json);
          return;
        }

        // Heartbeat NDJSON: `ping` every ~200 s holds the connection past Bun's
        // 255 s idleTimeout for slow local models, then one terminal event.
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let resolved = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as { type: string; message?: string } & ProfileResponse;
            if (event.type === "ping") continue;
            if (event.type === "error") throw new Error(event.message ?? "Profile generation failed");
            if (event.type === "result") {
              setData(event);
              resolved = true;
            }
          }
        }
        if (!resolved) throw new Error("Stream ended without a result");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [gameId, scope.carOrdinal, scope.trackOrdinal],
  );

  const clearCache = useCallback(async () => {
    const params = new URLSearchParams();
    if (scope.carOrdinal !== undefined) params.set("carOrdinal", String(scope.carOrdinal));
    if (scope.trackOrdinal !== undefined) params.set("trackOrdinal", String(scope.trackOrdinal));
    await fetch(`/api/drivers/profile?${params}`, { method: "DELETE", headers: { "X-Game-Id": gameId } });
    setData(null);
  }, [gameId, scope.carOrdinal, scope.trackOrdinal]);

  const fp = data?.fingerprint ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-app-text">Driver Profile</h1>
          <p className="text-sm text-app-text-muted">How you drive, and what to work on next.</p>
        </div>
        <div className="w-72">
          <SearchSelect value={scopeValue} onChange={setScopeValue} options={scopeOptions} placeholder="Choose scope…" />
        </div>
        <Button onClick={() => void run({ regenerate: !!data })} disabled={loading}>
          <Sparkles className="size-4" />
          {loading ? "Analysing…" : data ? "Regenerate" : "Build profile"}
        </Button>
        {data && (
          <Button variant="ghost" onClick={() => void clearCache()} aria-label="Clear cached profile">
            <Trash2 className="size-4" />
          </Button>
        )}
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-300 ring-1 ring-red-500/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!data && !loading && !error && (
        <div className="rounded-lg bg-app-surface p-8 text-center ring-1 ring-white/10">
          <p className="text-sm text-app-text-muted">Build a profile to see your driving-style measurements and a ranked improvement plan drawn from your lap history.</p>
        </div>
      )}

      {fp && <DriverProfileView fingerprint={fp} plan={data?.plan ?? null} cached={data?.cached} warnings={data?.warnings} />}
    </div>
  );
}
