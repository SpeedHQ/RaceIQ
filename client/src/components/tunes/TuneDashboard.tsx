import type { LapMeta } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { useLaps, useResolveNames, useSessions } from "../../hooks/queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { AutoTunePanel } from "./AutoTunePanel";
import { LapIssuesPanel } from "./LapIssuesPanel";
import { TuneLiveDashboard } from "./TuneLiveDashboard";

/** "live" follows the current on-track session's laps as they come in;
 *  a number selects a past recorded session by id. */
type Source = "live" | number;

/**
 * TuneDashboard — dedicated, tune-focused workspace (NOT embedded in the live
 * racing dashboard). Drives the symptom→intent→apply auto-tune pipeline off
 * either the live on-track session (auto-follow, hands-free) or any past
 * recorded session the driver picks.
 */
export function TuneDashboard({ gameId }: { gameId: "acc" | "ac-evo" }) {
  const { data: sessions = [], isLoading: loadingSessions } = useSessions();
  const { data: allLaps = [] } = useLaps();
  const liveSessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const livePacket = useTelemetryStore((s) => s.packet);

  // Most-recent-first, and only sessions that actually recorded laps —
  // an empty session has nothing to auto-tune from.
  const sortedSessions = useMemo(() => [...sessions].filter((s) => (s.lapCount ?? 0) > 0).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [sessions]);

  const [source, setSource] = useState<Source | "">("");

  // Default to live if the driver already has laps in on the current track
  // session; otherwise fall back to the most recent recorded session. Leave
  // the user's own pick alone once made.
  useEffect(() => {
    if (source !== "") return;
    if (liveSessionLaps.length > 0) {
      setSource("live");
    } else if (sortedSessions.length > 0) {
      setSource(sortedSessions[0].id);
    }
  }, [source, liveSessionLaps.length, sortedSessions]);

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
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 pb-0">
        <label className="text-xs text-app-text-dim">
          Session
          <select
            className="mt-1 w-full bg-app-panel border border-app-border rounded px-2 py-1 text-sm"
            value={source}
            onChange={(e) => setSource(e.target.value === "live" ? "live" : e.target.value ? Number(e.target.value) : "")}
            disabled={loadingSessions && sortedSessions.length === 0}
          >
            <option value="">{loadingSessions ? "Loading sessions…" : "Select a session…"}</option>
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
        <>
          <AutoTunePanel gameId={gameId} laps={sessionLaps} trackName={trackName ?? undefined} liveMode={false} />
          <LapIssuesPanel laps={sessionLaps} />
        </>
      )}
    </div>
  );
}
