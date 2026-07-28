/**
 * Driver profile — driving-style measurements plus a coached improvement plan.
 *
 * Two halves with different provenance, and the UI keeps them visually apart on
 * purpose. The left half is measured: it comes from the deterministic aggregator
 * and is true whether or not anyone ever calls a model. The right half is
 * written by the Driving Coach agent from those measurements. Presenting them as
 * one continuous document would let model prose borrow the authority of the
 * telemetry.
 */

import { getGame } from "@shared/games/registry";
import { AlertTriangle, ChevronDown, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SearchSelect } from "@/components/ui/SearchSelect";
import type { DriverFingerprint, RankedWeakness } from "../../../../server/ai/driver-profile-aggregate";
import type { DriverProfileOutput } from "../../../../server/ai/schemas";
import { useLaps } from "../../hooks/queries";
import { useRequiredGameId } from "../../stores/game";
import { StyleGauges } from "./StyleGauges";

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
// Focus areas
// ---------------------------------------------------------------------------

/**
 * The ranking already answered "what should I do first", so only the top item
 * opens. Showing every card expanded puts five equally-weighted walls of text on
 * screen and quietly undoes that ordering.
 */
function FocusArea({ area, rank, detector, defaultOpen }: { area: DriverProfileOutput["focusAreas"][number]; rank: number; detector: RankedWeakness | undefined; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg bg-app-surface ring-1 ring-white/10">
        <CollapsibleTrigger className="flex w-full items-start gap-3 p-3 text-left">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold tabular-nums text-app-text">{rank}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-app-text">{area.title}</span>
            <span className="mt-0.5 block text-xs text-app-text-muted">{detector ? `Seen on ${(detector.perLapFrequency * 100).toFixed(0)}% of laps` : "From your profile"}</span>
          </span>
          {/* Absent means the aggregator could not defend a number — deliberately
              blank rather than "0.00 s", which would read as "costs nothing". */}
          {area.estimatedGainS !== undefined && (
            <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium tabular-nums text-green-400">~{area.estimatedGainS.toFixed(2)}s</span>
          )}
          <ChevronDown className={`mt-0.5 size-4 shrink-0 text-app-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-3 border-t border-white/5 px-3 pb-3 pt-3 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-app-text-muted">What happens</p>
              <p className="mt-1 text-app-text">{area.whatHappens}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-app-text-muted">Why it costs</p>
              <p className="mt-1 text-app-text">{area.whyItCosts}</p>
            </div>
            <div className="rounded-md bg-blue-500/10 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-400">Drill</p>
              <p className="mt-1 text-app-text">{area.drill}</p>
            </div>
            {detector && (
              <p className="text-xs text-app-text-muted">
                Measured: {detector.label} · {detector.lapsAffected} lap{detector.lapsAffected === 1 ? "" : "s"} · peak severity {detector.peakSeverity}
                {detector.medianTimeLossS === null && " · cost not measured"}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
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
  const plan = data?.plan ?? null;
  const detectorById = useMemo(() => {
    const map = new Map<string, RankedWeakness>();
    for (const w of [...(fp?.weaknesses ?? []), ...(fp?.unquantifiedWeaknesses ?? [])]) map.set(w.id, w);
    return map;
  }, [fp]);

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

      {fp && (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ── Measured ───────────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-app-text">Driving style</h2>
                <span className="text-xs text-app-text-muted">
                  {fp.laps.analyzed} lap{fp.laps.analyzed === 1 ? "" : "s"} · {fp.confidence} confidence
                </span>
              </div>
              <p className="mb-2 text-xs text-app-text-muted">Measured from telemetry — these hold whether or not you run the coach.</p>
              {fp.style ? <StyleGauges style={fp.style} /> : <p className="py-4 text-sm text-app-text-muted">Not enough laps to characterise a style yet. Drive a few more and rebuild.</p>}
            </div>

            {fp.strengths.length > 0 && (
              <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                <h2 className="mb-1 text-sm font-semibold text-app-text">Faults you don't have</h2>
                <p className="mb-2 text-xs text-app-text-muted">Things the analyser looks for and never found. Never detected is weaker than proven — but it's still a good sign.</p>
                <ul className="space-y-1.5">
                  {fp.strengths.map((s) => (
                    <li key={s.id} className="flex items-baseline gap-2 text-sm text-app-text">
                      <span className="text-green-400">✓</span>
                      <span>
                        {s.label}
                        <span className="ml-1 text-xs text-app-text-muted">{s.basis === "absent" ? "never fired" : `only ${(s.perLapFrequency * 100).toFixed(0)}% of laps, info only`}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {fp.notes.length > 0 && (
              <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                <h2 className="mb-2 text-sm font-semibold text-app-text">Data caveats</h2>
                <ul className="space-y-1 text-xs text-app-text-muted">
                  {fp.notes.map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ── Coached ────────────────────────────────────────────────── */}
          <section className="space-y-4">
            {plan && (
              <>
                <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold text-app-text">{plan.styleLabel}</h2>
                    {data?.cached && <span className="text-xs text-app-text-muted">cached</span>}
                  </div>
                  <p className="text-sm text-app-text">{plan.summary}</p>
                </div>

                <div>
                  <h2 className="mb-2 text-sm font-semibold text-app-text">
                    Work on this, in order
                    <span className="ml-2 text-xs font-normal text-app-text-muted">most to gain first</span>
                  </h2>
                  <div className="space-y-2">
                    {plan.focusAreas.map((area, i) => (
                      <FocusArea key={area.detectorId} area={area} rank={i + 1} detector={detectorById.get(area.detectorId)} defaultOpen={i === 0} />
                    ))}
                  </div>
                  {/* The per-fault seconds are within-window estimates over
                      overlapping windows, so a total would be double-counted
                      fiction. Say so where someone would be tempted to add up. */}
                  {plan.focusAreas.some((a) => a.estimatedGainS !== undefined) && (
                    <p className="mt-2 text-[11px] text-app-text-muted/70">Time estimates are conservative and measured separately for each fault. They overlap, so don't add them up.</p>
                  )}
                </div>

                {plan.sessionPlan.length > 0 && (
                  <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                    <h2 className="mb-2 text-sm font-semibold text-app-text">Next session</h2>
                    <ol className="space-y-1.5">
                      {plan.sessionPlan.map((step, i) => (
                        <li key={step} className="flex gap-2 text-sm text-app-text">
                          <span className="text-app-text-muted tabular-nums">{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {plan.strengths.length > 0 && (
                  <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                    <h2 className="mb-2 text-sm font-semibold text-app-text">What's working</h2>
                    <ul className="space-y-2">
                      {plan.strengths.map((s) => (
                        <li key={s.title} className="text-sm">
                          <span className="font-medium text-app-text">{s.title}</span>
                          <span className="block text-xs text-app-text-muted">{s.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {data?.warnings?.map((w) => (
                  <p key={w} className="text-xs text-amber-400/80">
                    {w}
                  </p>
                ))}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
