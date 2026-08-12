import { PiBadge } from "@/components/forza/PiBadge";
import { Button } from "@/components/ui/button";
import { getCarModel } from "@/data/car-models";
import { m } from "@/paraglide/messages";
import { piClass } from "./helpers";
import { RatingBar } from "./RatingBar";
import type { Car, Formatters } from "./types";

type CarsGridProps = {
  cars: Car[];
  selected: Set<number>;
  configsReady: boolean;
  onSelect: (ordinal: number) => void;
  onDetail: (car: Car) => void;
  onModel: (ordinal: number) => void;
} & Formatters;

export function CarsGrid({ cars, selected, configsReady, onSelect, onDetail, onModel, fmtSpeed, fmtBrake, fmtWeight }: CarsGridProps) {
  if (cars.length === 0) return <div className="text-center py-12 text-app-text/90 text-sm">{m.cars_no_match()}</div>;

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
      {cars.map((car) => {
        const specs = car.specs!;
        const isSelected = selected.has(car.ordinal);
        return (
          // oxlint-disable-next-line a11y/useSemanticElements: card contains nested checkbox and navigation button
          <div
            key={car.ordinal}
            role="button"
            tabIndex={0}
            onClick={() => onDetail(car)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onDetail(car);
              }
            }}
            className={`relative rounded-xl border cursor-pointer transition-all hover:border-app-accent/50 hover:shadow-md ${isSelected ? "border-app-accent bg-app-accent/5" : "border-app-border bg-app-surface"}`}
          >
            <div className="absolute top-2 left-2 z-10">
              <input
                type="checkbox"
                checked={isSelected}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onSelect(car.ordinal)}
                className="w-3.5 h-3.5 accent-app-accent cursor-pointer"
              />
            </div>
            <div className="h-32 flex items-center justify-center bg-app-bg rounded-t-xl overflow-hidden px-3 pt-3 relative">
              {specs.imageUrl ? (
                <img src={specs.imageUrl} alt={car.name} loading="lazy" className="h-full w-full object-contain" />
              ) : (
                <div className="text-xs text-app-text/90">{m.cars_no_image()}</div>
              )}
              {configsReady && getCarModel(car.ordinal).hasModel && (
                <Button
                  variant="app-primary"
                  size="app-sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onModel(car.ordinal);
                  }}
                  className="absolute top-2 right-2 !px-1.5 !py-0.5 text-app-micro font-bold bg-app-accent/80 hover:bg-app-accent-hover border border-app-accent/30"
                  title={m.cars_view_3d_model()}
                >
                  3D
                </Button>
              )}
            </div>
            <div className="p-3 space-y-2">
              <div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {specs.pi > 0 && <PiBadge showNumber={false} pi={specs.pi} />}
                  <span className="text-app-caption font-semibold text-(--badge-color)" data-pi-class={piClass(specs.pi)}>
                    {specs.pi || ""}
                  </span>
                </div>
                <div className="text-xs font-semibold text-app-text/90 leading-tight mt-0.5 line-clamp-2">{car.name}</div>
                <div className="text-app-caption text-app-text/90 mt-0.5">
                  {specs.division || "—"} · {specs.drivetrain || "—"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-app-caption">
                <GridStat label="HP" value={specs.hp || "—"} />
                <GridStat label={m.cars_torque_label()} value={specs.torque || "—"} />
                <GridStat label={m.cars_top_spd_label()} value={fmtSpeed(specs.topSpeedMph)} />
                <GridStat label="0–60" value={specs.zeroToSixty ? `${specs.zeroToSixty}s` : "—"} />
                <GridStat label={m.cars_weight_label()} value={fmtWeight(specs.weightKg, specs.weightLbs)} />
                <GridStat label={m.cars_brake_60_label()} value={fmtBrake(specs.braking60)} />
              </div>
              {(specs.speedRating > 0 || specs.handlingRating > 0) && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {specs.speedRating > 0 && <RatingStat label="Spd" value={specs.speedRating} />}
                  {specs.handlingRating > 0 && <RatingStat label="Hdl" value={specs.handlingRating} />}
                  {specs.accelRating > 0 && <RatingStat label="Acc" value={specs.accelRating} />}
                  {specs.brakingRating > 0 && <RatingStat label="Brk" value={specs.brakingRating} />}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GridStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-app-text/90">{label}</span>
      <span className="tabular-nums text-app-text/90">{value}</span>
    </div>
  );
}

function RatingStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-app-micro text-app-text/90 w-6">{label}</span>
      <RatingBar value={value} />
    </div>
  );
}
