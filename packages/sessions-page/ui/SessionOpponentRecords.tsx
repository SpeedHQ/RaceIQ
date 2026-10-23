import { useState } from "react";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { useSessionsPageHost } from "./host";
export function SessionOpponentRecords({ session, laps, enabled }: { session: SessionMeta; laps: readonly LapMeta[]; enabled: boolean }) {
  const { m, useOpponentLapCatalog, formatLapTime } = useSessionsPageHost();
  const [playerLapId, setPlayerLapId] = useState<number | null>(null);
  const selected = laps.find((lap) => lap.id === playerLapId);
  const query = useOpponentLapCatalog(enabled ? selected?.id ?? null : null);
  return <section data-testid="opponent-sessions" aria-label={m.sessions_opponents()} className="border-t border-app-border p-3">
    <h3 className="text-sm font-semibold text-app-text">{m.sessions_opponents()}</h3>
    {laps.length === 0 ? <p>{m.sessions_opponents_choose_player_lap()}</p> : <label className="mt-2 block text-sm">
      {m.sessions_opponents_choose_player_lap()}
      <select aria-label={m.sessions_opponents_choose_player_lap()} data-testid="opponent-player-lap" value={playerLapId ?? ""} onChange={(event) => setPlayerLapId(event.target.value ? Number(event.target.value) : null)} className="ml-2 rounded border border-app-border bg-app-surface p-1">
        <option value="">—</option>{laps.map((lap) => <option key={lap.id} value={lap.id}>{m.label_lap()} {lap.lapNumber ?? lap.id} · {formatLapTime(lap.lapTime)}</option>)}
      </select>
    </label>}
    {selected && query.isLoading && <p role="status">{m.sessions_opponents_loading()}</p>}
    {selected && query.error && <p role="alert">{m.sessions_opponents_unavailable()}</p>}
    {selected && query.data && <>
      {query.data.opponentRetention !== "retained" || query.data.opponentAvailability === "missing" || query.data.opponentAvailability === "corrupt" ? <p role="status" data-opponent-retention={query.data.opponentRetention} data-opponent-availability={query.data.opponentAvailability ?? undefined}>{query.data.opponentRetention === "removed" ? m.compare_opponent_removed() : query.data.opponentRetention === "not-recorded" ? m.compare_opponent_not_recorded() : m.sessions_opponents_unavailable()}</p> : null}
      {query.data.sessions.map((opponent) => <article key={opponent.opponentSessionId} data-testid="opponent-session" data-opponent-session-id={opponent.opponentSessionId} className="mt-3 border-t border-app-border pt-2">
        <h4 className="text-sm font-medium">{opponent.driverName ?? m.common_unknown()} · {opponent.carName ?? "—"} · {opponent.className ?? "—"} · #{opponent.vehicleId}/{opponent.incarnation}</h4>
        {opponent.lapIds.map((id) => {
          const lap = query.data!.laps.find((item) => item.opponentLapId === id);
          if (!lap) return null;
          const disabled = lap.mode === "unavailable" || lap.comparableSemanticIds.length === 0;
          const warnings = [lap.coverage === "partial" ? m.compare_opponent_coverage_partial() : m.compare_opponent_coverage_complete(), lap.validity === "invalid" ? m.sessions_opponents_invalid() : lap.validity === "unknown" ? m.sessions_opponents_unknown() : null, lap.reasons.includes("restricted-channels") ? m.compare_opponent_restricted_channels() : null].filter(Boolean);
          const url = `/lmu/compare?track=${encodeURIComponent(session.trackId ?? "")}&carA=${encodeURIComponent(session.carId ?? "")}&lapA=${selected!.id}&reference=opponent&opponentLap=${encodeURIComponent(lap.opponentLapId)}&opponentRevision=${encodeURIComponent(query.data!.sourceRevision)}`;
          return <div key={id} data-testid="opponent-lap" data-opponent-lap-id={id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
            <span>{m.label_lap()} {lap.lapNumber ?? "—"} · {lap.lapTime.state === "ok" && lap.lapTime.value !== null ? formatLapTime(lap.lapTime.value) : "—"}</span>
            {warnings.length > 0 && <span className="text-app-text-dim">{[...new Set(warnings)].join(", ")}</span>}
            {disabled ? <span className="text-app-text-dim">{m.sessions_opponents_no_comparable()}</span> : <a aria-label={`${m.sessions_opponents_compare()} ${opponent.driverName ?? ""} ${lap.lapNumber ?? ""}`} href={url} className="text-app-accent underline">{m.sessions_opponents_compare()}</a>}
          </div>;
        })}
        {opponent.lapIds.length === 0 && <p>{m.sessions_opponents_none()}</p>}
      </article>)}
      {query.data.sessions.length === 0 && <p>{m.sessions_opponents_none()}</p>}
    </>}
  </section>;
}
