import { useState } from "react";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { OpponentLapSummary } from "@raceiq/lap-replay/contracts";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { ComparisonLapSelect } from "./ComparisonLapSelect";
import { m } from "@/paraglide/messages";
import { formatLapTime } from "@/lib/format";
import { Button } from "@/components/ui/button";

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
  opponentLapId = null,
  onOpponentLapChange,
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

function OpponentLapSelector({ laps: recordedLaps, value, onChange }: {
  laps: readonly OpponentLapSummary[];
  value: string | null;
  onChange?: (id: string | null) => void;
}) {
  const laps = recordedLaps.filter((lap) => lap.mode !== "unavailable");
  const identity = (lap: OpponentLapSummary) => JSON.stringify([lap.sessionKey, lap.vehicleId, lap.incarnation]);
  const committed = laps.find((lap) => lap.opponentLapId === value);
  const [className, setClassName] = useState("");
  const [driver, setDriver] = useState(committed ? identity(committed) : "");
  const [pendingId, setPendingId] = useState(value ?? "");
  const pending = laps.find((lap) => lap.opponentLapId === pendingId);
  const drivers = [...new Map(laps.filter((lap) => !className || lap.className === className)
    .map((lap) => [identity(lap), lap])).values()];
  const filtered = laps.filter((lap) => (!className || lap.className === className) && (!driver || identity(lap) === driver));
  const describe = (lap: OpponentLapSummary) => {
    const coverage = lap.coverage === "complete" ? m.compare_opponent_coverage_complete() : m.compare_opponent_coverage_partial();
    const validity = lap.validity === "valid" ? m.sessions_cleanup_valid() : lap.validity === "invalid" ? m.sessions_cleanup_invalid() : m.common_unknown();
    const mode = lap.mode === "telemetry" ? m.spectate_telemetry() : lap.mode === "timing-only" ? m.label_time() : m.analyse_unavailable();
    const time = lap.lapTime.state === "ok" && lap.lapTime.value !== null ? formatLapTime(lap.lapTime.value) : m.analyse_unavailable();
    return `${lap.driverName ?? m.label_driver()} · ${lap.carName ?? m.compare_car_fallback()} · ${lap.className ?? m.analyse_unknown_class()} · #${lap.vehicleId}/${lap.incarnation} · ${m.compare_lap_label()} ${lap.lapNumber ?? "?"} · ${time} · ${coverage} / ${validity} / ${mode}`;
  };
  return <>
    <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[160px]">
    <label htmlFor="compare-opponent-class" className="text-app-caption text-app-text-muted">{m.track_detail_class()}</label>
    <SearchSelect id="compare-opponent-class" value={className} ariaLabel={m.track_detail_class()}
      placeholder={m.acccars_all_classes()} options={[{ value: "", label: m.acccars_all_classes() },
        ...[...new Set(laps.flatMap((lap) => lap.className ? [lap.className] : []))].map((name) => ({ value: name, label: name }))]}
      onChange={(next) => { setClassName(next); setDriver(""); setPendingId(""); }} />
    </div>
    <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[180px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
    <label htmlFor="compare-opponent-driver" className="text-app-caption text-app-text-muted">{m.label_driver()}</label>
    <SearchSelect id="compare-opponent-driver" value={driver} ariaLabel={m.label_driver()} placeholder={m.label_driver()}
      options={drivers.map((lap) => ({ value: identity(lap), label: `${lap.driverName ?? m.label_driver()} · ${lap.carName ?? m.compare_car_fallback()} · #${lap.vehicleId}/${lap.incarnation}` }))}
      onChange={(next) => { setDriver(next); setPendingId(""); }} disabled={drivers.length === 0} />
    </div>
    <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[220px] @sm/workspace:flex-1 @3xl/workspace:max-w-[320px]">
    <label htmlFor="compare-opponent-lap" className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.compare_opponent_lap()}</label>
    <SearchSelect id="compare-opponent-lap" value={pendingId} onChange={setPendingId}
      options={filtered.map((lap) => ({ value: lap.opponentLapId, label: describe(lap), disabled: lap.mode === "unavailable" }))}
      placeholder={laps.length ? m.compare_opponent_lap() : m.compare_opponent_no_laps()} disabled={filtered.length === 0} />
    </div>
    {pending && pendingId !== value && <div role="status" className="w-full break-words text-app-caption text-app-text-secondary">
      <p>{describe(pending)}</p>
      <p>{m.compare_opponent_restricted_channels()}</p>
      {pending.comparableSemanticIds.length > 0 && <p>{pending.comparableSemanticIds.join(" · ")}</p>}
    </div>}
    <div className="flex gap-2">
      <Button type="button" variant="app-outline" size="app-sm"
        disabled={!pending || pending.mode === "unavailable" || pendingId === value}
        onClick={() => { if (pending && pending.mode !== "unavailable") onChange?.(pending.opponentLapId); }}>{m.lapcompare_feature_name()}</Button>
      <Button type="button" variant="app-outline" size="app-sm"
        onClick={() => { setPendingId(value ?? ""); setClassName(""); setDriver(committed ? identity(committed) : ""); }}>{m.common_cancel()}</Button>
    </div>
  </>;
}
