import { EXPERIMENT_FOCUS_AGENT_LABELS } from "@shared/experiments/focus";
import { getGame } from "@shared/games/registry";
import { isPitCycleLap } from "@shared/laps/pit-cycle";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { LapMeta } from "../../../../shared/sessions/types";
import {
  type ExperimentGameId,
  type ExperimentLapMetric,
  type ExperimentVersion,
  useAccCarName,
  useExperiment,
  useExperimentLapMetrics,
  useExperimentVersions,
  useLaps,
  useResolveNames,
} from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { client } from "../../lib/rpc";
import { useTelemetryStore } from "../../stores/telemetry";
import { Button } from "../ui/button";
import { AddBaseModal } from "./AddBaseModal";
import { BackButton } from "./BackButton";
import { FocusSwitcher } from "./FocusSwitcher";
import { HistoryPanel } from "./HistoryPanel";
import { ImportLapsModal } from "./ImportLapsModal";
import { LiveTestDashboard } from "./LiveTestDashboard";
import { TuneSetupChat } from "./TuneSetupChat";
import { VersionGraph } from "./VersionGraph";

/**
 * ExperimentWorkspace — the live-first workspace that opens *inside* a tuning
 * session (?experiment=<id>). The driver runs stints, the right panel
 * summarises the current stint as laps arrive, and Save & recommend runs the
 * deterministic autotune over the fastest valid lap, writes the next setup
 * version, and records it as a new tuning test (plan §1, Phase B).
 *
 * Per-lap fuel/lap and tyre wear (and the session Fuel/lap card) are real
 * server-derived numbers (Phase C, useExperimentLapMetrics) — wear is the
 * worst-tyre % worn per lap, from the game's tyre-wear channel. The spun flag is
 * omitted (parity Phase 2 spin detection). The right panel's setup chat
 * (TuneSetupChat) is a tool-using Setup Engineer agent
 * (docs/architecture/setup-engineer.md) — it reads the current setup and
 * symptoms itself via tools and calls apply_changes when the driver confirms,
 * so this component no longer drives a separate generate-from-chat mutation.
 */
export function ExperimentWorkspace({ gameId, experimentId }: { gameId: ExperimentGameId; experimentId: number }) {
  const navigate = useNavigate();
  const [showAddBase, setShowAddBase] = useState(false);
  const [showImportLaps, setShowImportLaps] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { data: session, isLoading: loadingSession } = useExperiment(experimentId);
  const { data: tests = [] } = useExperimentVersions(experimentId);
  /** Setup file the session is currently on: the head test's version, falling
   *  back to the session's base setup (before any test exists). */
  const { data: lapMetrics = [] } = useExperimentLapMetrics(experimentId);
  const accCarName = useAccCarName();
  const { data: allLaps = [] } = useLaps();
  const liveSessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const livePacket = useTelemetryStore((s) => s.packet);

  // Mark this session active while the workspace is open so every lap the
  // driver records is stamped with this experiment_id at insert (server
  // side). The active id lives in server memory (server/experiments/active.ts), so a
  // dev-server hot reload or restart silently drops it and every lap after that
  // lands unstamped — modelled as a TanStack query with a refetchInterval so
  // activation is re-asserted on a heartbeat (plus on window focus/reconnect)
  // and survives server restarts.
  useQuery({
    queryKey: ["experiment-activate", experimentId],
    queryFn: async () => {
      const api = client.api as any;
      const res = await api.experiments[":id"].activate.$post({ param: { id: String(experimentId) } });
      return res.json() as Promise<{ active: number | null }>;
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 0,
  });

  // Deactivate on unmount — queries have no unmount side effect, so this stays
  // an effect. The call is id-guarded server-side so a stale unmount can't
  // clobber a session the driver has since switched to.
  useEffect(() => {
    return () => {
      (client.api as any).experiments[":id"].deactivate.$post({ param: { id: String(experimentId) } }).catch(() => {});
    };
  }, [experimentId]);

  // Header car/track labels: setup-file-seeded sessions carry names directly;
  // ordinal-seeded ones resolve names from the ordinals.
  const { data: names } = useResolveNames(session?.trackOrdinal != null ? [session.trackOrdinal] : [], session?.carOrdinal != null ? [session.carOrdinal] : []);

  // The session's lap pool: persisted laps explicitly linked to this tuning
  // session (experimentId stamped server-side, spanning any number of race
  // sessions) merged with the live stint. Live laps belong to this session by
  // definition — the workspace activated it on mount, so the server is stamping
  // them — and are included even before the persisted query refetches. Laps
  // recorded before this feature have experimentId = null and won't appear.
  const sessionLapPool = useMemo<LapMeta[]>(() => {
    const byId = new Map<number, LapMeta>();
    for (const l of allLaps) {
      if (l.experimentId === experimentId) byId.set(l.id, l);
    }
    for (const l of liveSessionLaps) {
      // Live lap objects from the telemetry pipeline never carry the exclusion
      // fields (server/telemetry/live-pipeline.ts builds them without them), so keep the
      // persisted lap's flag AND its source when both exist — otherwise the
      // exclude toggle looks dead for laps of the current stint.
      // The source must survive: selectEvaluationLaps only reads a lap as
      // manually excluded when experimentExcludedSource === "manual", so dropping
      // it leaves the lap ranked in the fastest-N (stale "Eval" badge, no
      // replacement lap promoted).
      const persisted = byId.get(l.id);
      byId.set(l.id, persisted ? { ...l, experimentExcluded: persisted.experimentExcluded, experimentExcludedSource: persisted.experimentExcludedSource } : l);
    }
    return [...byId.values()];
  }, [allLaps, liveSessionLaps, experimentId]);

  // Server-derived per-lap metrics (fuel/lap + worst-tyre wear),
  // keyed by lap id for the table + the session Fuel/lap card.
  const metricsById = useMemo(() => {
    const m = new Map<number, ExperimentLapMetric>();
    for (const entry of lapMetrics) m.set(entry.lapId, entry);
    return m;
  }, [lapMetrics]);

  // Group the pool by tuning test using the createdAt window (plan §2):
  // a lap belongs to the newest test created at/before it; live laps land on the
  // latest (active) test.
  // Outlaps/inlaps/pit laps carry no tuning signal — excluded outright from
  // grouping, counts, and aggregates below.
  const experimentLapPool = useMemo(() => sessionLapPool.filter((l) => !isPitCycleLap(l)), [sessionLapPool]);

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
    for (const l of experimentLapPool) {
      const tid = testForLap(l);
      if (tid == null) continue;
      const arr = map.get(tid);
      if (arr) arr.push(l);
      else map.set(tid, [l]);
    }
    // Laps imported from several driving sessions restart lapNumber at 1, so
    // order by source session id first, then lap number within that session.
    for (const arr of map.values()) arr.sort((a, b) => a.sessionId - b.sessionId || a.lapNumber - b.lapNumber);
    return map;
  }, [experimentLapPool, tests]);

  // Session-wide stat rollups (hide a card when its value is unavailable).
  const validLaps = useMemo(() => experimentLapPool.filter((l) => l.isValid && l.lapTime > 0), [experimentLapPool]);
  const lapCount = experimentLapPool.length;
  const bestLap = validLaps.length ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
  const avgLap = validLaps.length ? validLaps.reduce((s, l) => s + l.lapTime, 0) / validLaps.length : null;
  const driveTime = experimentLapPool.reduce((s, l) => s + (l.lapTime > 0 ? l.lapTime : 0), 0);
  // Session Fuel/lap: average over the session's laps that have a real fuel
  // metric. null (card hidden) when none do — never a fabricated 0.
  const fuelVals = useMemo(() => experimentLapPool.map((l) => metricsById.get(l.id)?.fuelPerLap).filter((v): v is number => v != null), [experimentLapPool, metricsById]);
  const avgFuel = fuelVals.length ? fuelVals.reduce((s, v) => s + v, 0) / fuelVals.length : null;
  // Best setup = the tune test with the fastest single valid lap.
  const bestTest = useMemo(() => {
    let best: { test: ExperimentVersion; lapTime: number } | null = null;
    for (const t of tests) {
      const laps = (lapsByTest.get(t.id) ?? []).filter((l) => l.isValid && l.lapTime > 0);
      if (!laps.length) continue;
      const lapTime = Math.min(...laps.map((l) => l.lapTime));
      if (!best || lapTime < best.lapTime) best = { test: t, lapTime };
    }
    return best;
  }, [tests, lapsByTest]);

  // Live stint summary (right panel) straight from the telemetry store.
  const liveValid = useMemo(() => liveSessionLaps.filter((l) => l.isValid && l.lapTime > 0), [liveSessionLaps]);
  const liveBest = liveValid.length ? Math.min(...liveValid.map((l) => l.lapTime)) : null;
  const liveAvg = liveValid.length ? liveValid.reduce((s, l) => s + l.lapTime, 0) / liveValid.length : null;
  // Both ACC and AC-Evo populate acc.fuelPerLap; live-only (per-lap fuel for
  // recorded laps is Phase C).
  const liveFuelPerLap = livePacket?.acc?.fuelPerLap || null;
  const lapsDone = liveSessionLaps.length;
  // Phase 5 — track-length-aware stint nudge, advisory only. Falls back to 3
  // (the old hardcoded target) until the session payload lands.
  const lapTarget = session?.lapTarget ?? 3;

  const [testPhase, setTestPhase] = useState<"idle" | "live">("idle");

  const routePrefix = getGame(gameId).routePrefix;
  const clearSession = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: `/${routePrefix}/experiments` } as any);

  if (loadingSession || !session) {
    return (
      <div className="flex-1 p-3">
        <BackButton onClick={clearSession} className="mb-3" />
        <div className="text-sm text-app-text-dim mt-3">{loadingSession ? "Loading experiment…" : "Experiment not found."}</div>
      </div>
    );
  }

  const rawCarLabel = session.carName ?? (session.carOrdinal != null ? names?.carNames[String(session.carOrdinal)] : undefined) ?? null;
  const carLabel = gameId === "acc" ? accCarName(rawCarLabel) : rawCarLabel;
  const rawTrackLabel = session.trackName ?? (session.trackOrdinal != null ? names?.trackNames[String(session.trackOrdinal)] : undefined) ?? null;
  // Session trackName can be a raw folder slug (e.g. "brands_hatch") — turn
  // slug-looking values into a friendly title-cased label.
  const trackLabel = rawTrackLabel && /^[a-z0-9_-]+$/.test(rawTrackLabel) ? rawTrackLabel.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()) : rawTrackLabel;
  const subtitle = [carLabel, trackLabel].filter(Boolean).join(" · ");

  return (
    <div className="h-full flex flex-col overflow-hidden p-3 gap-3">
      {/* Header */}
      <div className="shrink-0">
        <BackButton onClick={clearSession} className="mb-2" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-app-title font-semibold text-app-text">
            <span className="text-app-text-muted font-mono mr-2">#{session.seq}</span>
            {session.name}
          </h1>
          <FocusSwitcher experimentId={session.id} focus={session.focus} />
        </div>
        {subtitle && <div className="mt-0.5 text-app-subtext text-app-text-muted">{subtitle}</div>}
      </div>

      {/* Main row fills the remaining height. Left column scrolls; the right
          panel (Recommend + chat) is permanent and full-height. */}
      {/* Chat column is hidden during a live test — the live dashboard gets the
          full width; chat returns on the review page / idle workspace. */}
      <div className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${testPhase === "live" ? "" : "@5xl/workspace:grid-cols-[1fr_360px]"}`}>
        {/* Left: tune-tests table normally; the live dashboard takes over the
            panel while a test is running. Review moved to its own route
            (…/review) — no tab switcher. */}
        <div className="min-h-0 flex flex-col border border-app-border rounded-lg overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto">
            {testPhase === "idle" ? (
              <>
                {/* Session overview — always rendered as placeholders ("—") so
                    the row layout doesn't jump once laps start landing. */}
                <div className="grid grid-cols-2 gap-2 border-b border-app-border p-2 @3xl/workspace:grid-cols-3 @5xl/workspace:grid-cols-6">
                  <StatCard label="Laps" value={String(lapCount)} />
                  <StatCard label="Best lap" value={bestLap != null ? formatLapTime(bestLap) : "—"} />
                  <StatCard label="Best setup" value={bestTest ? `${bestTest.test.label} · ${formatLapTime(bestTest.lapTime)}` : "—"} />
                  <StatCard label="Avg (valid) lap" value={avgLap != null ? formatLapTime(avgLap) : "—"} />
                  <StatCard label="Drive time" value={driveTime > 0 ? formatDuration(driveTime) : "—"} />
                  <StatCard label="Fuel/lap" value={avgFuel != null ? `${avgFuel.toFixed(2)} L` : "—"} />
                  {/* Tyre deg card omitted — ACC/AC-Evo expose no genuine tyre-wear channel. */}
                </div>
                <div className="flex items-center justify-between px-2 pt-2 flex-wrap gap-1">
                  <span className="text-app-caption uppercase tracking-wider text-app-text-muted">Version tree</span>
                  <div className="flex items-center gap-2">
                    <Button variant="app-outline" size="app-sm" onClick={() => setShowImportLaps(true)}>
                      Add laps from history
                    </Button>
                    {gameId !== "f1-2025" && (
                      <Button variant="app-outline" size="app-sm" onClick={() => setShowAddBase(true)}>
                        + Add base
                      </Button>
                    )}
                    <Button variant="app-outline" size="app-sm" onClick={() => setShowHistory(true)}>
                      History
                    </Button>
                  </div>
                </div>
                <VersionGraph
                  sessionId={session.id}
                  gameId={gameId}
                  tests={tests}
                  headVersionId={session?.headVersionId ?? null}
                  lapsByTest={lapsByTest}
                  metricsById={metricsById}
                  onOpenReview={(t) => {
                    setTestPhase("idle");
                    // Laps are derived from versionId in the review page (they're
                    // stamped with experiment_version_id), so the id alone is enough —
                    // no need to enumerate lap ids in the URL.
                    navigate({
                      to: `/${routePrefix}/experiments/${experimentId}/review`,
                      search: { versionId: t.id },
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any);
                  }}
                />
                {showAddBase && gameId !== "f1-2025" && <AddBaseModal gameId={gameId} sessionId={session.id} lockedCar={session.carName ?? undefined} onClose={() => setShowAddBase(false)} />}
                {showImportLaps && <ImportLapsModal gameId={gameId} sessionId={session.id} tests={tests} onClose={() => setShowImportLaps(false)} />}
                {showHistory && <HistoryPanel sessionId={session.id} onClose={() => setShowHistory(false)} />}
              </>
            ) : (
              <div className="h-full flex flex-col min-h-0">
                {/* Current stint strip — moved here from the page header (plan
                    follow-up) since it's specifically about the live test run. */}
                <div className="shrink-0 flex items-center justify-between gap-3 flex-wrap px-3 py-2 border-b border-app-border">
                  <div className="flex items-baseline gap-2">
                    <span className="text-app-caption uppercase tracking-wider text-app-text-muted">Current stint</span>
                    <span className={`text-xs ${lapsDone < lapTarget ? "text-status-warning" : "text-app-text-dim"}`}>
                      {lapsDone === 0
                        ? `No live laps yet — run ${lapTarget} clean laps this run for a reliable recommendation.`
                        : lapsDone < lapTarget
                          ? `${lapsDone} / ${lapTarget} laps this run`
                          : `${lapsDone} laps`}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <InlineStat label="Best" value={liveBest != null ? formatLapTime(liveBest) : "—"} />
                    <InlineStat label="Avg" value={liveAvg != null ? formatLapTime(liveAvg) : "—"} />
                    <InlineStat label="Fuel/lap" value={liveFuelPerLap != null ? `${liveFuelPerLap.toFixed(2)} L` : "—"} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="app-primary"
                      size="app-sm"
                      onClick={() => {
                        const lapIds = liveSessionLaps.map((l) => l.id);
                        setTestPhase("idle");
                        navigate({
                          to: `/${routePrefix}/experiments/${experimentId}/review`,
                          search: { laps: lapIds.join(",") },
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        } as any);
                      }}
                    >
                      Review laps
                    </Button>
                    <Button variant="app-outline" size="app-sm" onClick={() => setTestPhase("idle")}>
                      Close
                    </Button>
                  </div>
                </div>
                <div className="flex-1 min-h-0">
                  <LiveTestDashboard gameId={gameId} trackOrdinal={session.trackOrdinal ?? null} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: the Setup Engineer chat, full height. Recommending/applying a
            setup happens inside the conversation — the driver asks the agent to
            generate and it calls apply_changes itself (no separate buttons).
            Hidden during a live test — the live dashboard gets the full width. */}
        {testPhase === "idle" && (
          <div className="min-h-0 flex flex-col border border-app-border rounded-lg overflow-hidden">
            <div className="shrink-0 px-3 py-2 border-b border-app-border flex items-center justify-between">
              {/* The panel is the same agent either way, but naming it after
                  the current focus is the difference between "why is the setup
                  engineer talking about my braking" and an obvious mode. */}
              <span className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{EXPERIMENT_FOCUS_AGENT_LABELS[session.focus]}</span>
              <div className="flex items-center gap-3">
                <Button variant="app-primary" size="app-sm" onClick={() => setTestPhase("live")}>
                  Dashboard
                </Button>
                <CopyChatJsonButton sessionId={session.id} />
              </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <TuneSetupChat sessionId={session.id} headVersionId={session.headVersionId} />
            </div>
          </div>
        )}
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
      <div className="text-app-caption text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-mono font-black tabular-nums leading-none text-app-text/90">{value}</div>
    </div>
  );
}

/** Copy the persisted chat thread (full AI-SDK UIMessage[] — parts, tool calls,
 *  metadata) as JSON to the clipboard, from the setup-engineer header. Debug aid. */
function CopyChatJsonButton({ sessionId }: { sessionId: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="app-ghost"
      size="app-sm"
      onClick={async () => {
        try {
          const res = await fetch(`/api/experiments/${sessionId}/chat`);
          const data = res.ok ? await res.json() : { error: res.statusText };
          await navigator.clipboard.writeText(JSON.stringify(data.messages ?? data, null, 2));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      title="Copy chat JSON (debug)"
      className="!px-0 flex items-center gap-1 text-app-text-muted hover:text-app-text"
    >
      {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
      <span className="text-app-micro uppercase tracking-wider">{copied ? "Copied" : "JSON"}</span>
    </Button>
  );
}

/** Compact inline stat for the horizontal "Current stint" strip. */
function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-app-caption text-app-text-muted uppercase tracking-wider">{label}</span>
      <span className="text-sm font-mono tabular-nums text-app-text/90">{value}</span>
    </div>
  );
}

/** Per-lap breakdown for an expanded tune test. Fuel/lap is the real
 *  server-derived number (or "—" for legacy/unavailable laps); tyre wear stays
 *  "—" (no ACC/AC-Evo channel); the spun flag is omitted (parity Phase 2). */
