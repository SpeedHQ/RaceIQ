import { PiBadge } from "@/components/forza/PiBadge";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import { piClass } from "./helpers";
import type { Car, CarSpecs, Formatters } from "./types";

type StatRow = { label: string; getValue: (specs: CarSpecs) => string; highlight?: "low" | "high" };

export function CompareModal({ cars, onClose, fmtSpeed, fmtBrake, fmtWeight, isMetric }: { cars: Car[]; onClose: () => void; isMetric: boolean } & Formatters) {
  const rows: StatRow[] = [
    { label: m.cars_pi(), getValue: (s) => (s.pi > 0 ? `${piClass(s.pi)} ${s.pi}` : "—") },
    { label: m.cars_division(), getValue: (s) => s.division || "—" },
    { label: m.cars_drivetrain(), getValue: (s) => s.drivetrain || "—" },
    { label: m.cars_engine(), getValue: (s) => (s.engine ? `${s.engine}${s.displacement > 0 ? ` ${s.displacement}L` : ""}` : "—") },
    { label: m.cars_aspiration(), getValue: (s) => s.aspiration || "—" },
    { label: m.cars_gears(), getValue: (s) => (s.gears > 0 ? `${s.gears}-speed` : "—") },
    { label: m.cars_hp(), getValue: (s) => (s.hp > 0 ? `${s.hp}` : "—"), highlight: "high" },
    { label: m.cars_torque(), getValue: (s) => (s.torque > 0 ? `${s.torque}` : "—"), highlight: "high" },
    { label: m.cars_weight(), getValue: (s) => fmtWeight(s.weightKg, s.weightLbs), highlight: "low" },
    { label: m.cars_front_weight(), getValue: (s) => (s.frontWeightPct > 0 ? `${s.frontWeightPct}%` : "—") },
    { label: `${m.cars_top_speed()} (${isMetric ? "km/h" : "mph"})`, getValue: (s) => fmtSpeed(s.topSpeedMph), highlight: "high" },
    { label: isMetric ? m.cars_accel_metric_short() : m.cars_accel_imperial_short(), getValue: (s) => (s.zeroToSixty > 0 ? `${s.zeroToSixty}s` : "—"), highlight: "low" },
    { label: isMetric ? m.cars_accel_metric_long() : m.cars_accel_imperial_long(), getValue: (s) => (s.zeroToHundred > 0 ? `${s.zeroToHundred}s` : "—"), highlight: "low" },
    { label: m.cars_quarter_mile(), getValue: (s) => (s.quarterMile > 0 ? `${s.quarterMile}s` : "—"), highlight: "low" },
    { label: `${m.cars_brake_60()} (${isMetric ? "m" : "ft"})`, getValue: (s) => fmtBrake(s.braking60), highlight: "low" },
    { label: m.cars_lateral_g(), getValue: (s) => (s.lateralG60 > 0 ? `${s.lateralG60}g` : "—"), highlight: "high" },
    { label: m.cars_speed_rating(), getValue: (s) => (s.speedRating > 0 ? s.speedRating.toFixed(1) : "—"), highlight: "high" },
    { label: m.cars_braking_rating(), getValue: (s) => (s.brakingRating > 0 ? s.brakingRating.toFixed(1) : "—"), highlight: "high" },
    { label: m.cars_handling_rating(), getValue: (s) => (s.handlingRating > 0 ? s.handlingRating.toFixed(1) : "—"), highlight: "high" },
    { label: m.cars_accel_rating(), getValue: (s) => (s.accelRating > 0 ? s.accelRating.toFixed(1) : "—"), highlight: "high" },
    { label: m.cars_price(), getValue: (s) => (s.price > 0 ? s.price.toLocaleString() : "—") },
  ];

  const getBestIdx = (row: StatRow) => {
    if (!row.highlight) return [];
    const values = cars.map((car) => {
      const raw = car.specs ? row.getValue(car.specs) : "—";
      const value = parseFloat(raw.replace(/[^0-9.-]/g, ""));
      return Number.isNaN(value) ? null : value;
    });
    const valid = values.filter((value): value is number => value !== null);
    if (valid.length < 2) return [];
    const best = row.highlight === "high" ? Math.max(...valid) : Math.min(...valid);
    return values.map((value, index) => (value === best ? index : -1)).filter((index) => index >= 0);
  };
  const colWidth = Math.max(180, Math.floor(560 / cars.length));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="wide"
        showCloseButton={false}
        className="!top-8 !max-w-none !translate-y-0 overflow-auto rounded-xl bg-app-bg p-0"
        style={{ maxWidth: 160 + colWidth * cars.length, maxHeight: "90vh" }}
      >
        <DialogHeader className="sticky top-0 z-10 flex flex-row items-center justify-between border-b border-app-border bg-app-bg px-4 py-3">
          <DialogTitle className="text-app-heading font-bold text-app-text/90">{m.cars_compare_modal_title()}</DialogTitle>
          <Button variant="close-action" size="icon-sm" onClick={onClose} aria-label={m.common_close()}>
            ×
          </Button>
        </DialogHeader>
        <div className="overflow-auto">
          <Table density="compact" fit>
            <THead>
              <TH sticky="start">{m.cars_stat_column()}</TH>
              {cars.map((car) => (
                <TH key={car.ordinal} align="center">
                  {car.specs?.imageUrl && <img src={car.specs.imageUrl} alt={car.name} loading="lazy" className="mx-auto mb-1 h-14 w-full object-contain" />}
                  <div className="font-semibold leading-tight text-app-text/90">{car.name}</div>
                  {car.specs?.pi && <PiBadge showNumber={false} pi={car.specs.pi} />}
                </TH>
              ))}
            </THead>
            <TBody>
              {rows.map((row) => {
                const bestIdxs = getBestIdx(row);
                return (
                  <TRow key={`${row.label}|${bestIdxs.join(",")}`}>
                    <TD emphasis sticky="start" tone="primary">
                      {row.label}
                    </TD>
                    {cars.map((car, index) => {
                      const value = car.specs ? row.getValue(car.specs) : "—";
                      const isBest = bestIdxs.includes(index);
                      return (
                        <TD key={car.ordinal} align="center" emphasis={isBest} numeric tone={isBest ? "success" : "primary"}>
                          {value}
                        </TD>
                      );
                    })}
                  </TRow>
                );
              })}
            </TBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
