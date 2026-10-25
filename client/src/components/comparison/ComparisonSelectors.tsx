import { useState } from "react";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapSummary, OpponentSessionSummary } from "@raceiq/lap-replay/contracts";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { ComparisonLapSelect } from "./ComparisonLapSelect";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "@raceiq/frontend-pure/utc-date";
import { formatLapTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { useResolveNames } from "@/hooks/catalog-queries";

type TrackGroup = { trackId: string; trackName: string; laps: LapMeta[] };


export function ComparisonSelectors({
  trackGroups,
  selectedTrack,
  setSelectedTrack,
  carAId,
  setCarAId,
  carBId,
  setCarBId,
  lapAId,
  setLapAId,
  lapBId,
  setLapBId,
  trackCars,
  carNames,
  carALaps,
  carBLaps,
  referenceMode = "player",
  onReferenceModeChange,
  opponentLaps = [],
  onOpponentLapChange,
  opponentLapId = null,
}: {
  trackGroups: TrackGroup[];
  selectedTrack: string | null;
  setSelectedTrack: (value: string | null) => void;
  carAId: string | null;
  setCarAId: (value: string | null) => void;
  carBId: string | null;
  setCarBId: (value: string | null) => void;
  lapAId: number | null;
  setLapAId: (value: number | null) => void;
  lapBId: number | null;
  setLapBId: (value: number | null) => void;
  trackCars: string[];
  carNames: Map<string, string>;
  carALaps: LapMeta[];
  carBLaps: LapMeta[];
  referenceMode?: "player" | "opponent";
  onReferenceModeChange?: (mode: "player" | "opponent") => void;
  opponentLaps?: readonly OpponentLapSummary[];
  opponentLapId?: string | null;
  onOpponentLapChange?: (opponentLapId: string | null) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-end gap-3">
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[140px] @sm/workspace:flex-1 @3xl/workspace:max-w-[260px]">
        <label htmlFor="compare-track" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.label_track()}
        </label>
        <SearchSelect
          id="compare-track"
          value={selectedTrack ?? ""}
          onChange={(value) => setSelectedTrack(value || null)}
          options={trackGroups.map((group) => ({ value: group.trackId, label: `${group.trackName} (${group.laps.length} ${m.pitwindow_laps()})` }))}
          placeholder={m.compare_search_tracks()}
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-a)" }} />
          <label htmlFor="compare-car-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_car_a()}</label>
        </div>
        <SearchSelect value={carAId ?? ""} onChange={(value) => setCarAId(value || null)}
          options={trackCars.map((carId) => ({ value: carId, label: carNames.get(carId) || `${m.compare_car_fallback()} ${carId}` }))}
          placeholder={m.compare_search_cars()} disabled={!selectedTrack} />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
        <label htmlFor="compare-lap-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_lap_a()}</label>
        <ComparisonLapSelect id="compare-lap-a" label={m.compare_lap_a()} lapId={lapAId}
          onChange={setLapAId} laps={carALaps} disabled={!carAId} />
      </div>
      {onReferenceModeChange && <div className="flex min-w-0 flex-col gap-1">
        <span className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_lap_b()}</span>
        <div role="group" aria-label={m.compare_lap_b()} className="flex gap-1">
          <button type="button" aria-pressed={referenceMode === "player"} onClick={() => onReferenceModeChange?.("player")}
            className={`rounded-sm border px-2 py-2 text-app-label focus-visible:outline-2 focus-visible:outline-app-accent ${referenceMode === "player" ? "border-app-accent text-app-accent" : "border-app-border text-app-text-secondary"}`}>{m.compare_reference_mine()}</button>
          <button type="button" aria-pressed={referenceMode === "opponent"} onClick={() => onReferenceModeChange?.("opponent")}
            className={`rounded-sm border px-2 py-2 text-app-label focus-visible:outline-2 focus-visible:outline-app-accent ${referenceMode === "opponent" ? "border-app-accent text-app-accent" : "border-app-border text-app-text-secondary"}`}>{m.compare_reference_opponents()}</button>
        </div>
      </div>}
      {referenceMode === "opponent" ? <OpponentLapSelector
        key={`${selectedTrack}:${lapAId}:${opponentLapId}`}
        laps={opponentLaps} value={opponentLapId} onChange={onOpponentLapChange}
      /> : <>
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
          <label htmlFor="compare-car-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_car_b()}</label>
          <SearchSelect id="compare-car-b" value={carBId ?? ""} onChange={(value) => setCarBId(value || null)}
            options={trackCars.map((carId) => ({ value: carId, label: carNames.get(carId) || `${m.compare_car_fallback()} ${carId}` }))}
            placeholder={m.compare_search_cars()} disabled={!selectedTrack} />
        </div>
        <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
          <label htmlFor="compare-lap-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_lap_b()}</label>
          <ComparisonLapSelect id="compare-lap-b" label={m.compare_lap_b()} lapId={lapBId}
            onChange={setLapBId} laps={carBLaps} disabled={!carBId} />
        </div>
      </>}
    </div>
  );
}

export function OpponentLapSelector({ laps: recordedLaps, sessions: recordedSessions, value, onChange, selectImmediately = false, playerLaps = [], selectedPlayerLapId, playerCarName, onPlayerLapChange, savedSessions, selectedSavedSessionId, onSavedSessionChange }: {
  laps: readonly OpponentLapSummary[];
  sessions?: readonly OpponentSessionSummary[];
  value: string | null;
  onChange?: (id: string | null) => void;
  selectImmediately?: boolean;
  playerLaps?: readonly LapMeta[];
  selectedPlayerLapId?: number;
  playerCarName?: string;
  onPlayerLapChange?: (id: number) => void;
  savedSessions?: readonly SessionMeta[];
  selectedSavedSessionId?: number;
  onSavedSessionChange?: (id: number) => void;
}) {
  const { data: savedSessionNames } = useResolveNames(
    [...new Set(savedSessions?.map((session) => session.trackId) ?? [])],
    [...new Set(savedSessions?.map((session) => session.carId) ?? [])],
  );
  const laps = recordedLaps.filter((lap) => lap.mode !== "unavailable");
  const identity = (lap: OpponentLapSummary) => JSON.stringify([lap.sessionKey, lap.vehicleId, lap.incarnation]);
  const committed = laps.find((lap) => lap.opponentLapId === value);
  const [sessionKey, setSessionKey] = useState(committed?.sessionKey ?? "");
  const [driver, setDriver] = useState(committed ? identity(committed) : "");
  const [pendingId, setPendingId] = useState(value ?? "");
  const pending = laps.find((lap) => lap.opponentLapId === pendingId);
  const sessions = [...new Set((recordedSessions ?? laps).map((session) => session.sessionKey))];
  const drivers = [...new Map(laps.filter((lap) => !sessionKey || lap.sessionKey === sessionKey)
    .map((lap) => [identity(lap), lap])).values()];
  const filtered = laps.filter((lap) => (!sessionKey || lap.sessionKey === sessionKey) && (!driver || identity(lap) === driver));
  const playerLapOptions = playerLaps.map((lap) => ({
    value: `player:${lap.id}`,
    label: `${playerCarName ?? m.compare_car_fallback()} · ${m.label_lap()} ${lap.lapNumber} · ${formatLapTime(lap.lapTime)}`,
  }));
  const lapLabel = driver === "me" ? m.label_lap() : m.compare_opponent_lap();
  const describe = (lap: OpponentLapSummary) => {
    const time = lap.lapTime.state === "ok" && lap.lapTime.value !== null ? formatLapTime(lap.lapTime.value) : "—";
    return `${lap.carName ?? m.compare_car_fallback()} · ${m.compare_lap_label()} ${lap.lapNumber ?? "?"} · ${time}`;
  };
  return <>
    {savedSessions && <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[180px]">
      <label htmlFor="replay-saved-session" className="text-app-caption text-app-text-muted">{m.label_sessions()}</label>
      <SearchSelect id="replay-saved-session" value={selectedSavedSessionId == null ? "" : String(selectedSavedSessionId)} ariaLabel={m.label_sessions()}
        placeholder={m.label_sessions()} options={[...savedSessions].sort((a, b) => {
          const delta = parseUtcTimestamp(b.createdAt).getTime() - parseUtcTimestamp(a.createdAt).getTime();
          return (Number.isFinite(delta) && delta !== 0 ? delta : a.id - b.id);
        }).map((session) => {
          const date = parseUtcTimestamp(session.createdAt);
          const track = savedSessionNames?.trackNames[session.trackId];
          const car = savedSessionNames?.carNames[session.carId];
          return { value: String(session.id), label: [date.toLocaleString(getLocale()), track, car].filter(Boolean).join(" · ") };
        })}
        onChange={(next) => { const id = Number(next); if (Number.isSafeInteger(id)) onSavedSessionChange?.(id); }} />
    </div>}
    {!savedSessions && <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[160px]">
    <label htmlFor="compare-opponent-session" className="text-app-caption text-app-text-muted">{m.label_sessions()}</label>
    <SearchSelect id="compare-opponent-session" value={sessionKey} ariaLabel={m.label_sessions()}
      placeholder={m.label_sessions()} options={[{ value: "", label: m.label_sessions() },
        ...sessions.map((key, index) => ({ value: key, label: m.race_result_session_number({ id: index + 1 }) }))]}
      onChange={(next) => { setSessionKey(next); setDriver(""); setPendingId(""); }} />
    </div>}
    <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[180px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
    <label htmlFor="compare-opponent-driver" className="text-app-caption text-app-text-muted">{m.label_driver()}</label>
    <SearchSelect id="compare-opponent-driver" value={driver} ariaLabel={m.label_driver()} placeholder={m.label_driver()}
      options={[...(playerLaps.length ? [{ value: "me", label: "Me" }] : []),
        ...drivers.map((lap) => ({ value: identity(lap), label: lap.driverName ?? m.label_driver() }))]}
      onChange={(next) => {
        setDriver(next);
        setPendingId(next === "me" && selectedPlayerLapId != null ? `player:${selectedPlayerLapId}` : "");
      }} disabled={drivers.length === 0 && playerLaps.length === 0} />
    </div>
    <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[220px] @sm/workspace:flex-1 @3xl/workspace:max-w-[320px]">
    <label htmlFor="compare-opponent-lap" className="text-app-caption text-app-text-muted uppercase tracking-wider">{lapLabel}</label>
    <SearchSelect id="compare-opponent-lap" value={pendingId} ariaLabel={lapLabel} onChange={(next) => {
      if (driver === "me" && next.startsWith("player:")) {
        const playerLapId = Number(next.slice("player:".length));
        if (!Number.isSafeInteger(playerLapId)) return;
        if (selectImmediately) onPlayerLapChange?.(playerLapId);
        else setPendingId(next);
      } else if (selectImmediately) onChange?.(next || null);
      else setPendingId(next);
    }}
      options={driver === "me" ? playerLapOptions : filtered.map((lap) => ({ value: lap.opponentLapId, label: describe(lap) }))}
      placeholder={driver === "me" ? m.label_lap() : laps.length ? m.compare_opponent_lap() : m.compare_opponent_no_laps()}
      disabled={driver === "me" ? playerLapOptions.length === 0 : filtered.length === 0} />
    </div>
    {!selectImmediately && pending && pendingId !== value && <div role="status" className="w-full break-words text-app-caption text-app-text-secondary">
      <p>{describe(pending)}</p>
    </div>}
    {!selectImmediately && <div className="flex gap-2">
      <Button type="button" variant="app-outline" size="app-sm"
        disabled={!pending || pendingId === value}
        onClick={() => { if (pending) onChange?.(pending.opponentLapId); }}>{m.lapcompare_feature_name()}</Button>
      <Button type="button" variant="app-outline" size="app-sm"
        onClick={() => { setPendingId(value ?? ""); setSessionKey(committed?.sessionKey ?? ""); setDriver(committed ? identity(committed) : ""); }}>{m.common_cancel()}</Button>
    </div>}
  </>;
}
