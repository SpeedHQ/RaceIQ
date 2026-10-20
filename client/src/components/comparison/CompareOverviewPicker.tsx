import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

export function CompareOverviewPicker({ side, cars, carNames, carId, lapId, laps, onCarChange, onLapChange }: {
  side: "a" | "b";
  cars: string[];
  carNames: Map<string, string>;
  carId: string | null;
  lapId: number | null;
  laps: LapMeta[];
  onCarChange: (id: string | null) => void;
  onLapChange: (id: number | null) => void;
}) {
  const carLabel = side === "a" ? m.compare_car_a() : m.compare_car_b();
  const lapLabel = side === "a" ? m.compare_lap_a() : m.compare_lap_b();
  return (
    <div className="grid min-w-0 gap-2">
      <div className="min-w-0">
        <label htmlFor={`overview-car-${side}`} className="mb-1 block text-app-caption font-normal text-app-text-muted">{carLabel}</label>
        <SearchSelect id={`overview-car-${side}`} ariaLabel={carLabel} value={carId ?? ""}
          onChange={(id) => onCarChange(id || null)}
          options={cars.map((id) => ({ value: id, label: carNames.get(id) || `${m.compare_car_fallback()} ${id}` }))}
          placeholder={m.compare_search_cars()} className="h-7 w-full [&_input]:text-app-compact" />
      </div>
      <div className="min-w-0">
        <label htmlFor={`overview-lap-${side}`} className="mb-1 block text-app-caption font-normal text-app-text-muted">{lapLabel}</label>
        <SearchSelect id={`overview-lap-${side}`} ariaLabel={lapLabel} value={lapId == null ? "" : String(lapId)}
          onChange={(id) => onLapChange(id ? Number(id) : null)}
          options={laps.map((lap) => ({ value: String(lap.id), label: `${m.compare_lap_label()} ${lap.lapNumber} — ${formatLapTime(lap.lapTime)} — ${lap.ownership === "others" ? m.import_ownership_others() : m.import_ownership_mine()}` }))}
          disabled={!carId} placeholder={m.compare_search_laps()} className="h-7 w-full [&_input]:text-app-compact" />
      </div>
    </div>
  );
}
