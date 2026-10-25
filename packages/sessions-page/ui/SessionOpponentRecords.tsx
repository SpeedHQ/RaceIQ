import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { useSessionsPageHost } from "./host";

export function SessionOpponentRecords({ session, laps, enabled }: { session: SessionMeta; laps: readonly LapMeta[]; enabled: boolean }) {
  const { m, Button, Table, TableHeader, TableHead, TableBody, TableRow, TableCell, useOpponentLapCatalog, formatLapTime } = useSessionsPageHost();
  const navigate = useNavigate();
  const returnStateKey = `opponent-replay-return:${session.id}`;
  const [expandedOpponents, setExpandedOpponents] = useState<ReadonlySet<string>>(() => {
    try {
      const stored = sessionStorage.getItem(returnStateKey);
      const state = stored ? JSON.parse(stored) as { expanded?: unknown } : null;
      return new Set(Array.isArray(state?.expanded) ? state.expanded.filter((value): value is string => typeof value === "string") : []);
    } catch { return new Set(); }
  });
  const sectionRef = useRef<HTMLElement>(null);
  const restoredScrollRef = useRef(false);
  const [surfaceVisible, setSurfaceVisible] = useState(false);
  const selected = laps.find((lap) => lap.processing.state === "ready")
    ?? laps.find((lap) => lap.processing.stage === "opponent-index")
    ?? laps[0] ?? null;
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
  useEffect(() => {
    if (!selectedReady || !catalog || restoredScrollRef.current) return;
    try {
      const stored = sessionStorage.getItem(returnStateKey);
      if (!stored) return;
      const state = JSON.parse(stored) as { scrollTop?: unknown };
      const table = sectionRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
      if (!table) return;
      if (typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop)) table.scrollTop = state.scrollTop;
      restoredScrollRef.current = true;
      sessionStorage.removeItem(returnStateKey);
    } catch {}
  }, [catalog, returnStateKey, selectedReady]);
  return <section ref={sectionRef} data-testid="opponent-sessions" aria-label={m.sessions_opponents()} className="min-w-0 border-t border-app-border bg-black [&>[data-slot=table-container]]:max-h-96 [&>[data-slot=table-container]]:max-w-full [&>[data-slot=table-container]]:overflow-auto [&>[data-slot=table-container]]:rounded-none [&>[data-slot=table-container]]:border-0 [&_[data-slot=table-row]]:bg-black [&_[data-slot=table-head]]:bg-transparent">
    <h3 className="px-3 py-2 text-sm font-semibold text-app-text">{m.sessions_opponents()}</h3>
    {!selected && !processingMessage && <p>{m.sessions_opponents_none()}</p>}
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
      {selectedReady && catalog.indexState === "ready" && retainedDataAvailable && catalog.sessions.length > 0 && <Table className="min-w-[40rem]">
        <TableHeader className="sticky top-0 z-10 bg-black"><TableRow>
          <TableHead>{m.sessions_opponents_identity()}</TableHead>
          <TableHead className="text-right">{m.sessions_col_best_lap()}</TableHead>
          {[1, 2, 3].map((sector) => <TableHead key={sector} className="text-right">S{sector}</TableHead>)}
          <TableHead className="text-right">{m.label_laps()}</TableHead>
        </TableRow></TableHeader>
        {[...catalog.sessions].map((opponent, sourceIndex) => {
          const opponentLaps = opponent.lapIds.flatMap((id) => {
            const lap = catalog.laps.find((item) => item.opponentLapId === id);
            return lap ? [lap] : [];
          });
          const fastest = opponentLaps.reduce<typeof opponentLaps[number] | undefined>((best, lap) => {
            const time = lap.lapTime;
            if (time.state !== "ok" || time.value === null || !Number.isFinite(time.value) || time.value <= 0) return best;
            return !best || time.value < best.lapTime.value! ? lap : best;
          }, undefined);
          return { opponent, opponentLaps, fastest, sourceIndex };
        }).sort((a, b) => {
          if (a.fastest && b.fastest) return a.fastest.lapTime.value! - b.fastest.lapTime.value! || a.sourceIndex - b.sourceIndex;
          if (a.fastest) return -1;
          if (b.fastest) return 1;
          return a.sourceIndex - b.sourceIndex;
        }).map(({ opponent, opponentLaps, fastest }) => {
          const expanded = expandedOpponents.has(opponent.opponentSessionId);
          const detailsId = `opponent-laps-${session.id}-${opponent.opponentSessionId}`;
          return <TableBody key={opponent.opponentSessionId} data-testid="opponent-session" data-opponent-session-id={opponent.opponentSessionId}>
            <TableRow>
              <TableCell>
                <Button type="button" variant="app-ghost" size="app-sm" aria-expanded={expanded} aria-controls={detailsId} onClick={(event) => {
                  event.stopPropagation();
                  setExpandedOpponents((current) => {
                    const next = new Set(current);
                    if (next.has(opponent.opponentSessionId)) next.delete(opponent.opponentSessionId);
                    else next.add(opponent.opponentSessionId);
                    return next;
                  });
                }}>
                  <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                  {opponent.driverName ?? m.common_unknown()}
                </Button>
                <div className="mt-1 text-xs text-app-text-dim">{opponent.carName ?? "—"} · {opponent.className ?? "—"} · #{opponent.vehicleId}/{opponent.incarnation}</div>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums whitespace-nowrap">
                {fastest ? formatLapTime(fastest.lapTime.value!) : "—"}
                {fastest && fastest.validity !== "valid" && <div className="text-xs text-app-text-dim">{fastest.validity === "invalid" ? m.sessions_opponents_invalid() : m.sessions_opponents_unknown()}</div>}
              </TableCell>
              {[1, 2, 3].map((sector) => {
                const duration = fastest?.sectors.find((item) => item.semanticId === `timing.sector.last-lap.s${sector}`)?.duration;
                return <TableCell key={sector} className="text-right font-mono tabular-nums whitespace-nowrap">{duration?.state === "ok" && duration.value !== null && Number.isFinite(duration.value) && duration.value > 0 ? formatLapTime(duration.value) : "—"}</TableCell>;
              })}
              <TableCell className="text-right tabular-nums">{opponentLaps.length}</TableCell>
            </TableRow>
            <TableRow id={detailsId} hidden={!expanded} className="hover:bg-transparent">
              <TableCell colSpan={6} className="bg-black p-0 [&>[data-slot=table-container]]:rounded-none [&>[data-slot=table-container]]:border-0">
        {expanded && opponentLaps.length > 0 && <Table>
          <TableHeader><TableRow>
            <TableHead className="w-16 pl-6">{m.label_lap()}</TableHead>
            <TableHead className="w-32">{m.label_time()}</TableHead>
            <TableHead className="w-10" />
            <TableHead />
          </TableRow></TableHeader>
          <TableBody>{opponentLaps.map((lap) => {
          const id = lap.opponentLapId;
          const disabled = lap.mode === "unavailable" || lap.comparableSemanticIds.length === 0;
          const warnings = [lap.coverage === "partial" ? m.compare_opponent_coverage_partial() : m.compare_opponent_coverage_complete(), lap.validity === "invalid" ? m.sessions_opponents_invalid() : lap.validity === "unknown" ? m.sessions_opponents_unknown() : null, lap.reasons.includes("restricted-channels") ? m.compare_opponent_restricted_channels() : null].filter(Boolean);
          const details = [...new Set(warnings)].join(", ");
          return <TableRow key={id} data-testid="opponent-lap" data-opponent-lap-id={id}>
            <TableCell className="pl-6 font-mono tabular-nums">{lap.lapNumber ?? "—"}</TableCell>
            <TableCell className="font-mono tabular-nums">{lap.lapTime.state === "ok" && lap.lapTime.value !== null ? formatLapTime(lap.lapTime.value) : "—"}</TableCell>
            <TableCell>
              <details>
                <summary aria-label={details} title={details} className="cursor-pointer list-none text-app-text-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">ⓘ</summary>
                <p className="max-w-64 whitespace-normal py-2 text-xs text-app-text-dim">{details}</p>
              </details>
            </TableCell>
            <TableCell><div className="flex items-center gap-2">
            {lap.mode === "telemetry" && <Button type="button" variant="app-primary" size="app-sm" aria-label={`${m.sessions_replay_lap()} ${opponent.driverName ?? ""} ${lap.lapNumber ?? ""}`} onClick={(event) => {
              event.stopPropagation();
              try {
                const table = sectionRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
                sessionStorage.setItem(returnStateKey, JSON.stringify({ expanded: [...expandedOpponents], scrollTop: table?.scrollTop ?? 0 }));
              } catch {}
              void navigate({ to: `/lmu/sessions/${session.id}/replay/${selected!.id}` as never,
                search: { opponentLap: lap.opponentLapId, opponentRevision: catalog.sourceRevision } as never, resetScroll: false });
            }}>{m.sessions_replay_lap()}</Button>}
            {disabled ? <span aria-label={m.sessions_opponents_no_comparable()} title={m.sessions_opponents_no_comparable()} className="text-app-text-dim">—</span> : <Button type="button" variant="app-outline" size="app-sm" aria-label={`${m.sessions_opponents_compare()} ${opponent.driverName ?? ""} ${lap.lapNumber ?? ""}`} onClick={(event) => {
              event.stopPropagation();
              void navigate({ to: "/lmu/compare" as never, search: { track: session.trackId ?? "", carA: session.carId ?? "", lapA: selected!.id, reference: "opponent", opponentLap: lap.opponentLapId, opponentRevision: catalog.sourceRevision } as never });
            }}>{m.sessions_opponents_compare()}</Button>}
            </div></TableCell>
          </TableRow>;
        })}</TableBody>
        </Table>}
        {expanded && opponentLaps.length === 0 && <p>{m.sessions_opponents_none()}</p>}
              </TableCell>
            </TableRow>
          </TableBody>;
        })}
      </Table>}
      {selectedReady && catalog.indexState === "ready" && retainedDataAvailable && catalog.sessions.length === 0 && <p>{m.sessions_opponents_none()}</p>}
    </>}
  </section>;
}
