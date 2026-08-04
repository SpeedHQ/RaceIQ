import { m } from "@/paraglide/messages";
import { RatingBar } from "./RatingBar";
import type { Car, Formatters } from "./types";

export function CarDetail({ car, fmtSpeed, fmtBrake, fmtWeight, isMetric }: { car: Car; isMetric: boolean } & Formatters) {
  const s = car.specs;
  if (!s) return <div className="px-4 py-3 text-xs text-app-text/90">{m.cars_no_stats()}</div>;

  return (
    <div className="grid grid-cols-1 gap-4 border-t border-app-border bg-app-bg px-4 py-3 @3xl/workspace:grid-cols-[200px_1fr]">
      <div className="flex flex-col gap-2">
        {s.imageUrl ? (
          <img src={s.imageUrl} alt={car.name} loading="lazy" className="w-full rounded object-contain bg-app-surface p-2" style={{ maxHeight: 120 }} />
        ) : (
          <div className="w-full h-24 rounded bg-app-surface flex items-center justify-center text-xs text-app-text/90">{m.common_no_image()}</div>
        )}
        {s.synopsis && <p className="text-app-compact text-app-text/90 leading-relaxed line-clamp-4">{s.synopsis}</p>}
        {s.wikiUrl && (
          <a href={s.wikiUrl} target="_blank" rel="noopener noreferrer" className="text-app-caption text-app-accent hover:underline" onClick={(event) => event.stopPropagation()}>
            {m.cars_forza_wiki()}
          </a>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3">
        <div className="space-y-1">
          <div className="text-app-caption uppercase tracking-wider text-app-text/90 font-semibold">{m.cars_engine()}</div>
          <div className="text-app-text/90">
            {s.engine || "—"} {s.displacement > 0 ? `${s.displacement}L` : ""}
          </div>
          <div className="text-app-text/90">
            {s.hp > 0 ? `${s.hp} hp` : "—"} / {s.torque > 0 ? `${s.torque} lb-ft` : "—"}
          </div>
          <div className="text-app-text/90 capitalize">
            {s.aspiration || "—"} · {s.gears > 0 ? `${s.gears}-speed` : "—"}
          </div>
          <div className="text-app-text/90">
            {s.drivetrain} · {s.frontWeightPct > 0 ? `${s.frontWeightPct}/${100 - s.frontWeightPct} F/R` : ""}
          </div>
          <div className="text-app-text/90">{fmtWeight(s.weightKg, s.weightLbs)}</div>
        </div>

        <div className="space-y-1">
          <div className="text-app-caption uppercase tracking-wider text-app-text/90 font-semibold">{m.cars_performance()}</div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.cars_top_speed()}</span>
            <span className="text-app-text/90 tabular-nums">{fmtSpeed(s.topSpeedMph)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{isMetric ? m.cars_accel_metric_short() : m.cars_accel_imperial_short()}</span>
            <span className="text-app-text/90 tabular-nums">{s.zeroToSixty > 0 ? `${s.zeroToSixty}s` : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{isMetric ? m.cars_accel_metric_long() : m.cars_accel_imperial_long()}</span>
            <span className="text-app-text/90 tabular-nums">{s.zeroToHundred > 0 ? `${s.zeroToHundred}s` : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.cars_quarter_mile()}</span>
            <span className="text-app-text/90 tabular-nums">{s.quarterMile > 0 ? `${s.quarterMile}s` : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.cars_brake_60()}</span>
            <span className="text-app-text/90 tabular-nums">{fmtBrake(s.braking60)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-app-text/90">{m.cars_lateral_g()}</span>
            <span className="text-app-text/90 tabular-nums">{s.lateralG60 > 0 ? `${s.lateralG60}g` : "—"}</span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-app-caption uppercase tracking-wider text-app-text/90 font-semibold">{m.cars_ratings()}</div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90 w-16">{m.label_speed()}</span>
            <RatingBar value={s.speedRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90 w-16">{m.label_braking()}</span>
            <RatingBar value={s.brakingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90 w-16">{m.label_handling()}</span>
            <RatingBar value={s.handlingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90 w-16">{m.cars_rating_accel()}</span>
            <RatingBar value={s.accelRating} />
          </div>
          <div className="mt-1 text-app-caption text-app-text/90">
            {s.division && <span className="mr-2">{s.division}</span>}
            {s.price > 0 && <span>{s.price.toLocaleString()} CR</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
