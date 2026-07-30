import type { LapMeta } from "@shared/types";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useLaps, useResolveNames, useSessions } from "../../hooks/queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { BackButton } from "./BackButton";
import { TuneLiveDashboard } from "./TuneLiveDashboard";
import { TuneReviewDashboard } from "./TuneReviewDashboard";

/** "live" follows the current on-track session's laps as they come in;
 *  a number selects a past recorded session by id. */
type Source = "live" | number;

/**
 * TuneWorkspace — dedicated, tune-focused workspace (NOT embedded in the live
 * racing dashboard). Drives the symptom→intent→apply auto-tune pipeline off
 * either the live on-track session (auto-follow, hands-free) or any past
 * recorded session the driver picks.
 *
 * `embedded` hides the "← Experiments" back link and outer padding so the
 * component can sit *inside* ExperimentWorkspace as the detailed live/review
 * body (the workspace header already owns the back link). Standalone it renders
 * the back link itself.
 */
export function TuneWorkspace({ gameId, embedded = false }: { gameId: "acc" | "ac-evo"; embedded?: boolean }) {
  const { data: sessions = [], isLoading: loadingSessions } = useSessions();
  const { data: allLaps = [] } = useLaps();
  const liveSessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const livePacket = useTelemetryStore((s) => s.packet);

  // Most-recent-first, and only sessions that actually recorded laps —
  // an empty session has nothing to auto-tune from.
  const sortedSessions = useMemo(() => [...sessions].filter((s) => (s.lapCount ?? 0) > 0).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [sessions]);

  // Session selection lives in the URL (?session=live|<id>&lap=<id>) so a lap is
  // linkable. `lap` is owned by TuneReviewDashboard; we clear it when the session
  // changes so the new session picks its own default lap.
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { session?: Source; lap?: number };
  const source: Source | "" = search.session ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setSource = (v: Source | "") => navigate({ search: (prev: any) => ({ ...prev, session: v === "" ? undefined : v, lap: undefined }) } as any);

  // Default the session param when absent: live if a stint is running, else the
  // most recent recorded session. Replace history so back doesn't land on a
  // param-less URL.
  useEffect(() => {
    if (search.session != null) return;
    const next: Source | null = liveSessionLaps.length > 0 ? "live" : sortedSessions.length > 0 ? sortedSessions[0].id : null;
    if (next == null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ replace: true, search: (prev: any) => ({ ...prev, session: next }) } as any);
  }, [search.session, liveSessionLaps.length, sortedSessions, navigate]);

  const isLive = source === "live";
  const selectedSession = typeof source === "number" ? sortedSessions.find((s) => s.id === source) : undefined;

  // Resolve car/track names for the picker labels + the panel's trackName.
  const trackOrdinals = useMemo(() => sortedSessions.map((s) => s.trackOrdinal), [sortedSessions]);
  const carOrdinals = useMemo(() => sortedSessions.map((s) => s.carOrdinal), [sortedSessions]);
  const { data: names } = useResolveNames(trackOrdinals, carOrdinals);

  // Live mode resolves its own track name from the current packet, since the
  // live session isn't necessarily one of the past `sessions` rows yet.
  const liveTrackOrdinals = useMemo(() => (isLive && livePacket?.TrackOrdinal ? [livePacket.TrackOrdinal] : []), [isLive, livePacket?.TrackOrdinal]);
  const { data: liveNames } = useResolveNames(liveTrackOrdinals, []);

  const trackName = isLive
    ? livePacket?.TrackOrdinal
      ? liveNames?.trackNames[String(livePacket.TrackOrdinal)]
      : undefined
    : selectedSession
      ? names?.trackNames[String(selectedSession.trackOrdinal)]
      : undefined;

  const sessionLaps: LapMeta[] = useMemo(() => {
    if (isLive) return liveSessionLaps;
    if (typeof source !== "number") return [];
    return allLaps.filter((l) => l.sessionId === source);
  }, [isLive, liveSessionLaps, allLaps, source]);

  function sessionLabel(s: (typeof sortedSessions)[number]): string {
    const date = new Date(s.createdAt).toLocaleDateString();
    const time = new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const track = names?.trackNames[String(s.trackOrdinal)] ?? `Track ${s.trackOrdinal}`;
    const car = names?.carNames[String(s.carOrdinal)] ?? (s.carOrdinal ? `Car ${s.carOrdinal}` : "—");
    return `${date} ${time} — ${track} / ${car} (${s.lapCount ?? 0} laps)`;
  }

  return (
    <div className={embedded ? "" : "flex-1 overflow-y-auto"}>
      <div className="p-3 pb-0">
        {!embedded && (
          <BackButton
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={() => navigate({ to: `/${gameId}/experiments` } as any)}
            className="mb-2"
          />
        )}
        <label className="text-xs text-app-text-dim">
          Session
          <select
            className="mt-1 w-full bg-app-dropdown border border-app-border rounded px-2 py-1 text-sm"
            value={source}
            onChange={(e) => setSource(e.target.value === "live" ? "live" : e.target.value ? Number(e.target.value) : "")}
            disabled={loadingSessions && sortedSessions.length === 0}
          >
            <option value="">{loadingSessions ? "Loading experiments…" : "Select a session…"}</option>
            <option value="live">🔴 Live session</option>
            {sortedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLive ? (
        <TuneLiveDashboard gameId={gameId} trackName={trackName ?? undefined} sessionLaps={sessionLaps} />
      ) : (
        <TuneReviewDashboard gameId={gameId} laps={sessionLaps} trackName={trackName ?? undefined} />
      )}
    </div>
  );
}
