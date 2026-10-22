import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { ComparisonLapSelect } from "./ComparisonLapSelect";
import { m } from "@/paraglide/messages";

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
          <label htmlFor="compare-car-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_car_a()}
          </label>
        </div>
        <SearchSelect
          value={carAId ?? ""}
          onChange={(value) => setCarAId(value || null)}
          options={trackCars.map((carId) => ({ value: carId, label: carNames.get(carId) || `${m.compare_car_fallback()} ${carId}` }))}
          placeholder={m.compare_search_cars()}
          disabled={!selectedTrack}
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
        <label htmlFor="compare-lap-a" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.compare_lap_a()}
        </label>
          <ComparisonLapSelect id="compare-lap-a" label={m.compare_lap_a()} lapId={lapAId}
            onChange={setLapAId} laps={carALaps} disabled={!carAId} />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--comparison-lap-b)" }} />
          <label htmlFor="compare-car-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
            {m.compare_car_b()}
          </label>
        </div>
        <SearchSelect
          id="compare-car-b"
          value={carBId ?? ""}
          onChange={(value) => setCarBId(value || null)}
          options={trackCars.map((carId) => ({ value: carId, label: carNames.get(carId) || `${m.compare_car_fallback()} ${carId}` }))}
          placeholder={m.compare_search_cars()}
          disabled={!selectedTrack}
        />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-1 @sm/workspace:w-auto @sm/workspace:min-w-[120px] @sm/workspace:flex-1 @3xl/workspace:max-w-[200px]">
        <label htmlFor="compare-lap-b" className="text-app-caption text-app-text-muted uppercase tracking-wider">
          {m.compare_lap_b()}
        </label>
          <ComparisonLapSelect id="compare-lap-b" label={m.compare_lap_b()} lapId={lapBId}
            onChange={setLapBId} laps={carBLaps} disabled={!carBId} />
      </div>
    </div>
  );
}
