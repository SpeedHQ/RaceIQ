import { useEffect, useRef, useState } from "react";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { useSessionsPageHost } from "./host";

export function SessionOpponentRecords({ session, laps, enabled }: { session: SessionMeta; laps: readonly LapMeta[]; enabled: boolean }) {
  const { m, Button, useOpponentLapCatalog, formatLapTime } = useSessionsPageHost();
  const [playerLapId, setPlayerLapId] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [surfaceVisible, setSurfaceVisible] = useState(false);
  const selected = laps.find((lap) => lap.id === playerLapId) ?? null;
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new ResizeObserver(([entry]) => {
      setSurfaceVisible(Boolean(entry && entry.contentRect.width > 0 && entry.contentRect.height > 0));
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const sessionReady = session.processing.state === "ready";
  const selectedReady = sessionReady && selected?.processing.state === "ready";
  const catalogReadable = sessionReady && selected != null &&
    (selected.processing.state === "ready" || selected.processing.stage === "opponent-index");
  const query = useOpponentLapCatalog(enabled && surfaceVisible && catalogReadable ? selected!.id : null);
  const catalog = query.isFetching && !query.data ? undefined : query.data;
  const processing = !sessionReady ? session.processing : selected?.processing.state !== "ready" ? selected?.processing : undefined;
  const catalogStatusVisible = processing?.stage === "opponent-index" &&
    (query.error != null || (catalog != null && catalog.indexState !== "ready"));
  const processingMessage = catalogStatusVisible ? null
    : processing?.state === "queued" ? m.recording_processing_queued()
      : processing?.state === "processing" ? m.recording_processing_running()
        : processing?.state === "failed" ? m.recording_processing_failed({ error: processing.error })
          : null;
  const retainedDataAvailable = catalog?.opponentRetention === "retained" &&
    catalog.opponentAvailability !== "missing" && catalog.opponentAvailability !== "corrupt";
  const errorCode = query.error && "code" in query.error ? query.error.code : null;
  return <section ref={sectionRef} data-testid="opponent-sessions" aria-label={m.sessions_opponents()} className="border-t border-app-border p-3">
    <h3 className="text-sm font-semibold text-app-text">{m.sessions_opponents()}</h3>
    {laps.length === 0 ? <p>{m.sessions_opponents_choose_player_lap()}</p> : <label className="mt-2 block text-sm">
      {m.sessions_opponents_choose_player_lap()}
      <select aria-label={m.sessions_opponents_choose_player_lap()} data-testid="opponent-player-lap" disabled={!enabled || !sessionReady} value={playerLapId ?? ""} onChange={(event) => setPlayerLapId(event.target.value ? Number(event.target.value) : null)} className="ml-2 rounded border border-app-border bg-app-surface p-1">
        <option value="">—</option>{laps.map((lap) => {
          const lapProcessing = lap.processing.state === "queued" ? m.recording_processing_queued()
            : lap.processing.state === "processing" ? m.recording_processing_running()
              : lap.processing.state === "failed" ? m.recording_processing_failed({ error: lap.processing.error })
                : null;
          return <option key={lap.id} value={lap.id} disabled={!sessionReady || lap.processing.state !== "ready"}>{m.label_lap()} {lap.lapNumber ?? lap.id} · {formatLapTime(lap.lapTime)}{lapProcessing ? ` · ${lapProcessing}` : ""}</option>;
        })}
      </select>
    </label>}
    {processingMessage && <p role={processing?.state === "failed" ? "alert" : "status"} data-processing-state={processing?.state}>{processingMessage}</p>}
    {selected && query.isFetching && !processingMessage && <p role="status">{m.sessions_opponents_loading()}</p>}
    {selected && query.error && errorCode === "OPPONENT_DATA_REMOVED" && <p role="status" data-opponent-state="removed">{m.compare_opponent_removed()}</p>}
    {selected && query.error && errorCode === "OPPONENT_INDEX_FAILED" && <div role="alert" data-opponent-state="failed" className="flex flex-wrap items-center gap-2">
      <span>{m.compare_opponent_index_failed()}</span>
      {selected.processing.state === "failed" && selected.processing.stage === "opponent-index" && <span>{selected.processing.error}</span>}
      <Button type="button" variant="app-outline" size="app-sm" onClick={() => { void query.refetch(); }}>{m.recording_processing_refresh()}</Button>
    </div>}
    {selected && query.error && errorCode !== "OPPONENT_DATA_REMOVED" && errorCode !== "OPPONENT_INDEX_FAILED" && <p role="alert">{m.sessions_opponents_unavailable()}</p>}
    {selected && catalog && <>
      {catalog.opponentRetention === "removed" && <p role="status" data-opponent-state="removed">{m.compare_opponent_removed()}</p>}
      {catalog.opponentRetention === "not-recorded" && <p role="status" data-opponent-state="not-recorded">{m.compare_opponent_not_recorded()}</p>}
      {(catalog.opponentAvailability === "missing" || catalog.opponentAvailability === "corrupt") && <p role="status" data-opponent-state={catalog.opponentAvailability}>{catalog.opponentAvailability === "corrupt" ? m.storage_opponents_skip_invalid_source() : m.lmu_state_missing()}</p>}
      {retainedDataAvailable && catalog.indexState === "waiting-finalization" && <p role="status" data-opponent-state="waiting-finalization">{m.compare_opponent_index_waiting()}</p>}
      {retainedDataAvailable && catalog.indexState === "queued" && <p role="status" data-opponent-state="queued">{m.compare_opponent_index_queued()}</p>}
      {retainedDataAvailable && catalog.indexState === "building" && <p role="status" data-opponent-state="building">{m.compare_opponent_index_building()}</p>}
      {retainedDataAvailable && catalog.indexState === "failed" && <div role="alert" data-opponent-state="failed" className="flex flex-wrap items-center gap-2">
        <span>{m.compare_opponent_index_failed()}</span>
        {selected.processing.state === "failed" && selected.processing.stage === "opponent-index" && <span>{selected.processing.error}</span>}
        <Button type="button" variant="app-outline" size="app-sm" onClick={() => { void query.refetch(); }}>{m.recording_processing_refresh()}</Button>
      </div>}
      {catalog.indexState === "not-required" && catalog.opponentRetention === "retained" && catalog.opponentAvailability !== "missing" && catalog.opponentAvailability !== "corrupt" && <p role="status" data-opponent-state="not-required">{m.sessions_opponents_unavailable()}</p>}
      {selectedReady && catalog.indexState === "ready" && retainedDataAvailable && catalog.sessions.map((opponent) => <article key={opponent.opponentSessionId} data-testid="opponent-session" data-opponent-session-id={opponent.opponentSessionId} className="mt-3 border-t border-app-border pt-2">
        <h4 className="text-sm font-medium">{opponent.driverName ?? m.common_unknown()} · {opponent.carName ?? "—"} · {opponent.className ?? "—"} · #{opponent.vehicleId}/{opponent.incarnation}</h4>
        {opponent.lapIds.map((id) => {
          const lap = catalog.laps.find((item) => item.opponentLapId === id);
          if (!lap) return null;
          const disabled = lap.mode === "unavailable" || lap.comparableSemanticIds.length === 0;
          const warnings = [lap.coverage === "partial" ? m.compare_opponent_coverage_partial() : m.compare_opponent_coverage_complete(), lap.validity === "invalid" ? m.sessions_opponents_invalid() : lap.validity === "unknown" ? m.sessions_opponents_unknown() : null, lap.reasons.includes("restricted-channels") ? m.compare_opponent_restricted_channels() : null].filter(Boolean);
          const url = `/lmu/compare?track=${encodeURIComponent(session.trackId ?? "")}&carA=${encodeURIComponent(session.carId ?? "")}&lapA=${selected!.id}&reference=opponent&opponentLap=${encodeURIComponent(lap.opponentLapId)}&opponentRevision=${encodeURIComponent(catalog.sourceRevision)}`;
          return <div key={id} data-testid="opponent-lap" data-opponent-lap-id={id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
            <span>{m.label_lap()} {lap.lapNumber ?? "—"} · {lap.lapTime.state === "ok" && lap.lapTime.value !== null ? formatLapTime(lap.lapTime.value) : "—"}</span>
            {warnings.length > 0 && <span className="text-app-text-dim">{[...new Set(warnings)].join(", ")}</span>}
            {disabled ? <span className="text-app-text-dim">{m.sessions_opponents_no_comparable()}</span> : <a aria-label={`${m.sessions_opponents_compare()} ${opponent.driverName ?? ""} ${lap.lapNumber ?? ""}`} href={url} className="text-app-accent underline">{m.sessions_opponents_compare()}</a>}
          </div>;
        })}
        {opponent.lapIds.length === 0 && <p>{m.sessions_opponents_none()}</p>}
      </article>)}
      {selectedReady && catalog.indexState === "ready" && retainedDataAvailable && catalog.sessions.length === 0 && <p>{m.sessions_opponents_none()}</p>}
    </>}
  </section>;
}
