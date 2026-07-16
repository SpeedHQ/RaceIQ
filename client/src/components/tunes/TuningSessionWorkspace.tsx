import type { LapMeta } from "@shared/types";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type TuningLapMetric, useLaps, useResolveNames, useTuningSession, useTuningSessionLapMetrics, useTuningSessionTests } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { client } from "../../lib/rpc";
import { useTelemetryStore } from "../../stores/telemetry";
import { BackButton } from "./BackButton";
import { TuneSetupChat } from "./TuneSetupChat";
import { TuneWorkspace } from "./TuneWorkspace";
import { VersionGraph } from "./VersionGraph";

/**
 * TuningSessionWorkspace — the live-first workspace that opens *inside* a tuning
 * session (?tuningSession=<id>). The driver runs stints, the right panel
 * summarises the current stint as laps arrive, and Save & recommend runs the
 * deterministic autotune over the fastest valid lap, writes the next setup
 * version, and records it as a new tuning test (plan §1, Phase B).
 *
 * Per-lap fuel/lap and the session Fuel/lap card are real server-derived numbers
 * (Phase C, useTuningSessionLapMetrics). Tyre wear stays "—": ACC/AC-Evo shared
 * memory exposes no genuine wear channel, so nothing is faked. The spun flag is
 * omitted (parity Phase 2 spin detection). The right panel's setup chat
 * (TuneSetupChat) is a tool-using Setup Engineer agent
 * (docs/setup-engineer-tools-plan.md §3) — it reads the current setup and
 * symptoms itself via tools and calls apply_changes when the driver confirms,
 * so this component no longer drives a separate generate-from-chat mutation.
 */
export function TuningSessionWorkspace({ gameId, tuningSessionId }: { gameId: "acc" | "ac-evo"; tuningSessionId: number }) {
  const navigate = useNavigate();
  const { data: session, isLoading: loadingSession } = useTuningSession(tuningSessionId);
  const { data: tests = [] } = useTuningSessionTests(tuningSessionId);
  const { data: lapMetrics = [] } = useTuningSessionLapMetrics(tuningSessionId);
  const { data: allLaps = [] } = useLaps();
  const liveSessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const livePacket = useTelemetryStore((s) => s.packet);

  // Mark this session active on mount so every lap the driver records while the
  // workspace is open is stamped with this tuning_session_id at insert (server
  // side). Clear it on unmount. Depends only on the id — the deactivate call is
  // id-guarded server-side so it can't clobber a session switched to elsewhere.
  useEffect(() => {
    const api = client.api as any;
    api["tuning-sessions"][":id"].activate.$post({ param: { id: String(tuningSessionId) } }).catch(() => {});
    return () => {
      api["tuning-sessions"][":id"].deactivate.$post({ param: { id: String(tuningSessionId) } }).catch(() => {});
    };
  }, [tuningSessionId]);

  // Header car/track labels: setup-file-seeded sessions carry names directly;
  // ordinal-seeded ones resolve names from the ordinals.
  const { data: names } = useResolveNames(session?.trackOrdinal != null ? [session.trackOrdinal] : [], session?.carOrdinal != null ? [session.carOrdinal] : []);

  // The session's lap pool: persisted laps explicitly linked to this tuning
  // session (tuningSessionId stamped server-side, spanning any number of race
  // sessions) merged with the live stint. Live laps belong to this session by
  // definition — the workspace activated it on mount, so the server is stamping
  // them — and are included even before the persisted query refetches. Laps
  // recorded before this feature have tuningSessionId = null and won't appear.
  const sessionLapPool = useMemo<LapMeta[]>(() => {
    const byId = new Map<number, LapMeta>();
    for (const l of allLaps) {
      if (l.tuningSessionId === tuningSessionId) byId.set(l.id, l);
    }
    for (const l of liveSessionLaps) byId.set(l.id, l);
    return [...byId.values()];
  }, [allLaps, liveSessionLaps, tuningSessionId]);

  // Server-derived per-lap metrics (fuel/lap; tyre wear omitted — no channel),
  // keyed by lap id for the table + the session Fuel/lap card.
  const metricsById = useMemo(() => {
    const m = new Map<number, TuningLapMetric>();
    for (const entry of lapMetrics) m.set(entry.lapId, entry);
    return m;
  }, [lapMetrics]);

  // Group the pool by tuning test using the createdAt window (plan §2):
  // a lap belongs to the newest test created at/before it; live laps land on the
  // latest (active) test.
  const lapsByTest = useMemo(() => {
    const sorted = [...tests].sort((a, b) => a.version - b.version);
    const testForLap = (lap: LapMeta): number | null => {
      let match: number | null = sorted[0]?.id ?? null;
      const lapMs = new Date(lap.createdAt).getTime();
      for (const t of sorted) {
        if (new Date(t.createdAt).getTime() <= lapMs) match = t.id;
        else break;
      }
      return match;
    };
    const map = new Map<number, LapMeta[]>();
    for (const l of sessionLapPool) {
      const tid = testForLap(l);
      if (tid == null) continue;
      const arr = map.get(tid);
      if (arr) arr.push(l);
      else map.set(tid, [l]);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.lapNumber - b.lapNumber);
    return map;
  }, [sessionLapPool, tests]);

  // Session-wide stat rollups (hide a card when its value is unavailable).
  const validLaps = useMemo(() => sessionLapPool.filter((l) => l.isValid && l.lapTime > 0), [sessionLapPool]);
  const lapCount = sessionLapPool.length;
  const bestLap = validLaps.length ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
  const avgLap = validLaps.length ? validLaps.reduce((s, l) => s + l.lapTime, 0) / validLaps.length : null;
  const driveTime = sessionLapPool.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
  // Session Fuel/lap: average over the session's laps that have a real fuel
  // metric. null (card hidden) when none do — never a fabricated 0.
  const fuelVals = useMemo(() => sessionLapPool.map((l) => metricsById.get(l.id)?.fuelPerLap).filter((v): v is number => v != null), [sessionLapPool, metricsById]);
  const avgFuel = fuelVals.length ? fuelVals.reduce((s, v) => s + v, 0) / fuelVals.length : null;

  // Live stint summary (right panel) straight from the telemetry store.
  const liveValid = useMemo(() => liveSessionLaps.filter((l) => l.isValid && l.lapTime > 0), [liveSessionLaps]);
  const liveBest = liveValid.length ? Math.min(...liveValid.map((l) => l.lapTime)) : null;
  const liveAvg = liveValid.length ? liveValid.reduce((s, l) => s + l.lapTime, 0) / liveValid.length : null;
  // Both ACC and AC-Evo populate acc.fuelPerLap; live-only (per-lap fuel for
  // recorded laps is Phase C).
  const liveFuelPerLap = livePacket?.acc?.fuelPerLap || null;
  const lapsDone = liveSessionLaps.length;

  const clearSession = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${gameId}/tune` } as any);

  if (loadingSession || !session) {
    return (
      <div className="flex-1 p-3">
        <BackButton onClick={clearSession} className="mb-3" />
        <div className="text-sm text-app-text-dim mt-3">{loadingSession ? "Loading session…" : "Tuning session not found."}</div>
      </div>
    );
  }

  const carLabel = session.carName ?? (session.carOrdinal != null ? names?.carNames[String(session.carOrdinal)] : undefined) ?? null;
  const trackLabel = session.trackName ?? (session.trackOrdinal != null ? names?.trackNames[String(session.trackOrdinal)] : undefined) ?? null;
  const subtitle = [carLabel, trackLabel].filter(Boolean).join(" · ");

  return (
    <div className="h-full flex flex-col overflow-hidden p-3 gap-3">
      {/* Header */}
      <div className="shrink-0">
        <BackButton onClick={clearSession} className="mb-2" />
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-app-text">
            <span className="text-app-text-muted font-mono mr-2">#{session.seq}</span>
            {session.name}
          </h1>
          {subtitle && <div className="text-xs text-app-text-muted">{subtitle}</div>}
        </div>
      </div>

      {/* Stat cards */}
      <div className="shrink-0">
        {lapCount === 0 ? (
          <div className="text-xs text-app-text-dim border border-app-border rounded-lg px-3 py-2">
            No laps recorded for this session yet. Head out on track — the stats and stint summary fill in as laps complete.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <StatCard label="Laps" value={String(lapCount)} />
            {bestLap != null && <StatCard label="Best lap" value={formatLapTime(bestLap)} />}
            {avgLap != null && <StatCard label="Avg (valid) lap" value={formatLapTime(avgLap)} />}
            {driveTime > 0 && <StatCard label="Drive time" value={formatDuration(driveTime)} />}
            {avgFuel != null && <StatCard label="Fuel/lap" value={`${avgFuel.toFixed(2)} L`} />}
            {/* Tyre deg card hidden — ACC/AC-Evo expose no genuine tyre-wear channel. */}
          </div>
        )}
      </div>

      {/* Current stint strip — moved out of the right panel (above the table) so
          the right column gives its full height to the AI chat. */}
      <div className="shrink-0 flex items-center justify-between gap-3 flex-wrap border border-app-border rounded-lg px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Current stint</span>
          <span className={`text-xs ${lapsDone < 3 ? "text-amber-400" : "text-app-text-dim"}`}>
            {lapsDone === 0 ? "No live laps yet — run 3+ clean laps for a reliable recommendation." : lapsDone < 3 ? `${lapsDone} / 3 laps` : `${lapsDone} laps`}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <InlineStat label="Best" value={liveBest != null ? formatLapTime(liveBest) : "—"} />
          <InlineStat label="Avg" value={liveAvg != null ? formatLapTime(liveAvg) : "—"} />
          <InlineStat label="Fuel/lap" value={liveFuelPerLap != null ? `${liveFuelPerLap.toFixed(2)} L` : "—"} />
        </div>
      </div>

      {/* Main row fills the remaining height. Left column scrolls; the right
          panel (Recommend + chat) is permanent and full-height. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
        {/* Left: tune-tests table + detailed dashboard (scrolls) */}
        <div className="min-h-0 lg:overflow-y-auto space-y-3 pr-0.5">
          <div className="border border-app-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-app-border text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tune tests (setup versions)</div>
            <VersionGraph sessionId={session.id} tests={tests} headTestId={session?.headTestId ?? null} lapsByTest={lapsByTest} metricsById={metricsById} />
          </div>

          {/* Review-secondary: the detailed live/review dashboard (plan §3). */}
          <details className="border border-app-border rounded-lg overflow-hidden">
            <summary className="px-3 py-2 text-xs font-semibold text-app-text-muted uppercase tracking-wider cursor-pointer hover:text-app-text">Detailed live / review dashboard</summary>
            <div className="border-t border-app-border">
              <TuneWorkspace gameId={gameId} embedded />
            </div>
          </details>
        </div>

        {/* Right: the Setup Engineer chat, full height. Recommending/applying a
            setup happens inside the conversation — the driver asks the agent to
            generate and it calls apply_changes itself (no separate buttons). */}
        <div className="min-h-0 flex flex-col border border-app-border rounded-lg overflow-hidden">
          <div className="shrink-0 px-3 py-2 border-b border-app-border flex items-center justify-between">
            <span className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Setup engineer</span>
            <CopyChatJsonButton sessionId={session.id} />
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <TuneSetupChat sessionId={session.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Filename stem (no directory, no .json) of a setup path. */
function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const totalMin = Math.round(sec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${h}h ${min}m`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-3">
      <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-mono font-black tabular-nums leading-none text-app-text/90">{value}</div>
    </div>
  );
}

/** Copy the persisted chat thread (full AI-SDK UIMessage[] — parts, tool calls,
 *  metadata) as JSON to the clipboard, from the setup-engineer header. Debug aid. */
function CopyChatJsonButton({ sessionId }: { sessionId: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          const res = await fetch(`/api/tuning-sessions/${sessionId}/chat`);
          const data = res.ok ? await res.json() : { error: res.statusText };
          await navigator.clipboard.writeText(JSON.stringify(data.messages ?? data, null, 2));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      title="Copy chat JSON (debug)"
      className="flex items-center gap-1 text-app-text-muted hover:text-app-text"
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
      <span className="text-[9px] uppercase tracking-wider">{copied ? "Copied" : "JSON"}</span>
    </button>
  );
}

/** Compact inline stat for the horizontal "Current stint" strip. */
function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-app-text-muted uppercase tracking-wider">{label}</span>
      <span className="text-sm font-mono tabular-nums text-app-text/90">{value}</span>
    </div>
  );
}

/** Per-lap breakdown for an expanded tune test. Fuel/lap is the real
 *  server-derived number (or "—" for legacy/unavailable laps); tyre wear stays
 *  "—" (no ACC/AC-Evo channel); the spun flag is omitted (parity Phase 2). */
