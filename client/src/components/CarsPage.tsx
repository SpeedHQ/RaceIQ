import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { getCarModel, loadCarModelConfigs } from "../data/car-models";
import { useUnits } from "../hooks/useUnits";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { useRequiredGameId } from "../stores/game";
import { PiBadge, piClass } from "./forza/PiBadge";
import { AppInput } from "./ui/AppInput";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";

import { Button } from "./ui/button";
interface CarSpecs {
  hp: number;
  torque: number;
  weightLbs: number;
  weightKg: number;
  displacement: number;
  engine: string;
  drivetrain: string;
  gears: number;
  aspiration: string;
  frontWeightPct: number;
  pi: number;
  speedRating: number;
  brakingRating: number;
  handlingRating: number;
  accelRating: number;
  price: number;
  division: string;
  topSpeedMph: number;
  quarterMile: number;
  zeroToSixty: number;
  zeroToHundred: number;
  braking60: number;
  braking100: number;
  lateralG60: number;
  lateralG120: number;
  imageUrl: string;
  wikiUrl: string;
  synopsis: string;
}

interface Car {
  ordinal: number;
  name: string;
  specs?: CarSpecs;
}

type SortKey =
  | "name"
  | "pi"
  | "hp"
  | "torque"
  | "weightKg"
  | "topSpeedMph"
  | "zeroToSixty"
  | "zeroToHundred"
  | "braking60"
  | "speedRating"
  | "brakingRating"
  | "handlingRating"
  | "accelRating"
  | "division";

const PI_CLASSES = ["D", "C", "B", "A", "S", "R", "P", "X"];
const DRIVETRAINS = ["FWD", "RWD", "AWD"];

function RatingBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-app-border rounded-full overflow-hidden">
        <div className="h-full bg-app-accent rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-app-caption tabular-nums text-app-text/90 w-5">{value.toFixed(1)}</span>
    </div>
  );
}

function CarDetail({
  car,
  fmtSpeed,
  fmtBrake,
  fmtWeight,
  isMetric,
}: {
  car: Car;
  fmtSpeed: (mph: number) => string;
  fmtBrake: (ft: number) => string;
  fmtWeight: (kg: number, lbs: number) => string;
  isMetric: boolean;
}) {
  const s = car.specs;
  if (!s) return <div className="px-4 py-3 text-xs text-app-text/90">{m.cars_no_stats()}</div>;

  return (
    <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4 bg-app-bg border-t border-app-border">
      {/* Image */}
      <div className="flex flex-col gap-2">
        {s.imageUrl ? (
          <img src={s.imageUrl} alt={car.name} loading="lazy" className="w-full rounded object-contain bg-app-surface p-2" style={{ maxHeight: 120 }} />
        ) : (
          <div className="w-full h-24 rounded bg-app-surface flex items-center justify-center text-xs text-app-text/90">{m.common_no_image()}</div>
        )}
        {s.synopsis && <p className="text-app-compact text-app-text/90 leading-relaxed line-clamp-4">{s.synopsis}</p>}
        {s.wikiUrl && (
          <a href={s.wikiUrl} target="_blank" rel="noopener noreferrer" className="text-app-caption text-app-accent hover:underline" onClick={(e) => e.stopPropagation()}>
            {m.cars_forza_wiki()}
          </a>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-xs">
        {/* Engine */}
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

        {/* Performance */}
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

        {/* Ratings */}
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

function CompareModal({
  cars,
  onClose,
  fmtSpeed,
  fmtBrake,
  fmtWeight,
  isMetric,
}: {
  cars: Car[];
  onClose: () => void;
  fmtSpeed: (mph: number) => string;
  fmtBrake: (ft: number) => string;
  fmtWeight: (kg: number, lbs: number) => string;
  isMetric: boolean;
}) {
  type StatRow = { label: string; getValue: (s: CarSpecs) => string; highlight?: "low" | "high" };
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

  // Determine best values for numeric highlighting
  function getBestIdx(row: StatRow): number[] {
    if (!row.highlight) return [];
    const vals = cars.map((c) => {
      const raw = c.specs ? row.getValue(c.specs) : "—";
      const n = parseFloat(raw.replace(/[^0-9.-]/g, ""));
      return isNaN(n) ? null : n;
    });
    const valid = vals.filter((v): v is number => v !== null);
    if (valid.length < 2) return [];
    const best = row.highlight === "high" ? Math.max(...valid) : Math.min(...valid);
    return vals.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  }

  const colWidth = Math.max(180, Math.floor(560 / cars.length));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-app-bg/70 pt-8 pb-4 px-4 overflow-auto" onClick={onClose}>
      <div
        className="bg-app-bg border border-app-border rounded-xl shadow-2xl w-full overflow-auto"
        style={{ maxWidth: 160 + colWidth * cars.length, maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border sticky top-0 bg-app-bg z-10">
          <h2 className="text-sm font-bold text-app-text/90">{m.cars_compare_modal_title()}</h2>
          <Button type="button" variant="app-ghost" size="icon-sm" onClick={onClose} className="!h-auto !w-auto !p-1 text-app-text/90 hover:text-app-text" aria-label={m.common_close()}>
            ×
          </Button>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-app-border">
                <th className="text-left px-4 py-2 text-app-text/90 font-medium sticky left-0 bg-app-bg" style={{ minWidth: 160 }}>
                  {m.cars_stat_column()}
                </th>
                {cars.map((car) => (
                  <th key={car.ordinal} className="px-3 py-2 text-center" style={{ minWidth: colWidth }}>
                    {car.specs?.imageUrl && <img src={car.specs.imageUrl} alt={car.name} loading="lazy" className="h-14 w-full object-contain mx-auto mb-1" />}
                    <div className="font-semibold text-app-text/90 leading-tight">{car.name}</div>
                    {car.specs?.pi && <PiBadge showNumber={false} pi={car.specs.pi} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const bestIdxs = getBestIdx(row);
                return (
                  <tr key={ri} className={ri % 2 === 0 ? "bg-app-surface/30" : ""}>
                    <td className="px-4 py-1.5 text-app-text/90 sticky left-0 bg-inherit font-medium" style={{ minWidth: 160 }}>
                      {row.label}
                    </td>
                    {cars.map((car, ci) => {
                      const val = car.specs ? row.getValue(car.specs) : "—";
                      const isBest = bestIdxs.includes(ci);
                      return (
                      <td key={car.ordinal} className={`px-3 py-1.5 text-center tabular-nums ${isBest ? "text-status-success font-semibold" : "text-app-text/90"}`}>
                          {val}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ColHeader({ k, label, className = "", sort, sortDir, onSort }: { k: SortKey; label: string; className?: string; sort: SortKey; sortDir: 1 | -1; onSort: (k: SortKey) => void }) {
  const active = sort === k;
  return (
    <button
      onClick={() => onSort(k)}
      className={`text-left text-app-caption uppercase tracking-wider font-semibold transition-colors ${active ? "text-app-accent" : "text-app-text/90 hover:text-app-text"} ${className}`}
    >
      {label}
      {active ? (sortDir === 1 ? " ↑" : " ↓") : ""}
    </button>
  );
}

export function CarsPage() {
  const navigate = useNavigate();
  const gameId = useRequiredGameId();
  const searchParams = useSearch({ strict: false }) as { compare?: string };
  const [configsReady, setConfigsReady] = useState(false);
  useEffect(() => {
    loadCarModelConfigs().then(() => setConfigsReady(true));
  }, []);
  const units = useUnits();
  const isMetric = units.unit === "metric";
  function fmtSpeed(mph: number) {
    return mph ? `${units.fromMph(mph).toFixed(1)} ${units.speedLabel}` : "—";
  }
  function fmtBrake(ft: number) {
    return ft ? `${isMetric ? (ft * 0.3048).toFixed(1) + " m" : ft + " ft"}` : "—";
  }
  function fmtWeight(kg: number, lbs: number) {
    return kg ? `${isMetric ? kg + " kg" : lbs + " lb"}` : "—";
  }

  const { data: cars = [], isLoading } = useQuery<Car[]>({
    queryKey: ["cars", gameId],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": gameId } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<Car[]>;
    },
    staleTime: 60_000,
  });

  // Parse ?compare=1,2,3 from URL
  const compareParam = searchParams.compare;
  const initialCompareIds = useMemo(() => {
    if (!compareParam) return null;
    return new Set(
      compareParam
        .split(",")
        .map(Number)
        .filter((n) => !isNaN(n)),
    );
  }, [compareParam]);

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [driveFilter, setDriveFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(() => initialCompareIds ?? new Set());
  const [comparing, setComparing] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "grid">(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) return "grid";
    return "table";
  });
  const [detailCar, setDetailCar] = useState<Car | null>(null);

  // Auto-open compare modal when cars load and ?compare param is present
  useEffect(() => {
    if (initialCompareIds && initialCompareIds.size >= 2 && cars.length > 0) {
      setSelected(initialCompareIds);
      setComparing(true);
    }
  }, [initialCompareIds, cars.length]);

  const filtered = useMemo(() => {
    let list = cars.filter((c) => c.specs);
    if (classFilter) list = list.filter((c) => c.specs && piClass(c.specs.pi) === classFilter);
    if (driveFilter) list = list.filter((c) => c.specs?.drivetrain === driveFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.specs?.division?.toLowerCase().includes(q) || c.specs?.engine?.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (sort === "name") return sortDir * a.name.localeCompare(b.name);
      if (sort === "division") return sortDir * (a.specs?.division ?? "").localeCompare(b.specs?.division ?? "");
      const av = a.specs?.[sort] ?? -Infinity;
      const bv = b.specs?.[sort] ?? -Infinity;
      return sortDir * ((av as number) - (bv as number));
    });
  }, [cars, search, classFilter, driveFilter, sort, sortDir]);

  const carMap = useMemo(() => new Map(cars.map((c) => [c.ordinal, c])), [cars]);
  const selectedCars = useMemo(() => [...selected].map((id) => carMap.get(id)).filter((c): c is Car => !!c), [selected, carMap]);

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(key);
      setSortDir(key === "name" ? 1 : -1);
    }
  }

  function toggleSelect(ordinal: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(ordinal)) s.delete(ordinal);
      else s.add(ordinal);
      return s;
    });
  }

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center flex-wrap gap-2">
        {/* View mode toggle */}
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          <Button
            type="button"
            variant="app-ghost"
            size="icon-sm"
            onClick={() => setViewMode("table")}
            title={m.label_table_view()}
            className={`!h-auto !w-auto !rounded-none !p-2.5 transition-colors ${viewMode === "table" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18" />
            </svg>
          </Button>
          <Button
            type="button"
            variant="app-ghost"
            size="icon-sm"
            onClick={() => setViewMode("grid")}
            title={m.label_grid_view()}
            className={`!h-auto !w-auto !rounded-none !p-2.5 transition-colors ${viewMode === "grid" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </Button>
        </div>

        <AppInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={m.cars_search_placeholder()} className="flex-1 min-w-[180px] sm:flex-none sm:w-52" />

        <div className="flex items-center flex-wrap gap-1">
          {PI_CLASSES.map((cls) => (
            <Button
              key={cls}
              type="button"
              variant="app-ghost"
              size="app-sm"
              onClick={() => setClassFilter(classFilter === cls ? null : cls)}
              className={`!h-auto !px-3 !py-1.5 text-xs font-bold ${classFilter === cls ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text border border-app-border"}`}
            >
              {cls}
            </Button>
          ))}
        </div>

        <div className="flex items-center flex-wrap gap-1">
          {DRIVETRAINS.map((d) => (
            <Button
              key={d}
              type="button"
              variant="app-ghost"
              size="app-sm"
              onClick={() => setDriveFilter(driveFilter === d ? null : d)}
              className={`!h-auto !px-3 !py-1.5 text-xs font-semibold ${driveFilter === d ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text border border-app-border"}`}
            >
              {d}
            </Button>
          ))}
        </div>
      </div>

      {/* Table / Grid */}
      {isLoading ? (
        <div className="text-center py-16 text-app-text/90 text-sm">{m.cars_loading()}</div>
      ) : viewMode === "grid" ? (
        <>
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-app-text/90 text-sm">{m.cars_no_match()}</div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {filtered.map((car) => {
                const s = car.specs!;
                const isSel = selected.has(car.ordinal);
                return (
                  <div
                    key={car.ordinal}
                    onClick={() => setDetailCar(car)}
                    className={`relative rounded-xl border cursor-pointer transition-all hover:border-app-accent/50 hover:shadow-md ${isSel ? "border-app-accent bg-app-accent/5" : "border-app-border bg-app-surface"}`}
                  >
                    {/* Checkbox */}
                    <div onClick={(e) => toggleSelect(car.ordinal, e)} className="absolute top-2 left-2 z-10">
                      <input type="checkbox" checked={isSel} onChange={() => {}} className="w-3.5 h-3.5 accent-app-accent cursor-pointer" />
                    </div>

                    {/* Image */}
                    <div className="h-32 flex items-center justify-center bg-app-bg rounded-t-xl overflow-hidden px-3 pt-3 relative">
                      {s.imageUrl ? (
                        <img src={s.imageUrl} alt={car.name} loading="lazy" className="h-full w-full object-contain" />
                      ) : (
                        <div className="text-xs text-app-text/90">{m.cars_no_image()}</div>
                      )}
                      {configsReady && getCarModel(car.ordinal).hasModel && (
                        <Button
                          type="button"
                          variant="app-primary"
                          size="app-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate({ to: "/fm23/cars/$carOrdinal", params: { carOrdinal: String(car.ordinal) } });
                          }}
                          className="!h-auto absolute top-2 right-2 !px-1.5 !py-0.5 text-app-micro font-bold bg-app-accent/80 hover:bg-app-accent-hover border border-app-accent/30"
                          title={m.cars_view_3d_model()}
                        >
                          3D
                        </Button>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-3 space-y-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {s.pi > 0 && <PiBadge showNumber={false} pi={s.pi} />}
                          <span className="text-app-caption font-semibold text-(--badge-color)" data-pi-class={piClass(s.pi)}>
                            {s.pi || ""}
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-app-text/90 leading-tight mt-0.5 line-clamp-2">{car.name}</div>
                        <div className="text-app-caption text-app-text/90 mt-0.5">
                          {s.division || "—"} · {s.drivetrain || "—"}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-app-caption">
                        <div className="flex justify-between">
                          <span className="text-app-text/90">HP</span>
                          <span className="tabular-nums text-app-text/90">{s.hp || "—"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text/90">{m.cars_torque_label()}</span>
                          <span className="tabular-nums text-app-text/90">{s.torque || "—"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text/90">{m.cars_top_spd_label()}</span>
                          <span className="tabular-nums text-app-text/90">{fmtSpeed(s.topSpeedMph)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text/90">0–60</span>
                          <span className="tabular-nums text-app-text/90">{s.zeroToSixty ? `${s.zeroToSixty}s` : "—"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text/90">{m.cars_weight_label()}</span>
                          <span className="tabular-nums text-app-text/90">{fmtWeight(s.weightKg, s.weightLbs)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-app-text/90">{m.cars_brake_60_label()}</span>
                          <span className="tabular-nums text-app-text/90">{fmtBrake(s.braking60)}</span>
                        </div>
                      </div>

                      {(s.speedRating > 0 || s.handlingRating > 0) && (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                          {s.speedRating > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-app-micro text-app-text/90 w-6">Spd</span>
                              <RatingBar value={s.speedRating} />
                            </div>
                          )}
                          {s.handlingRating > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-app-micro text-app-text/90 w-6">Hdl</span>
                              <RatingBar value={s.handlingRating} />
                            </div>
                          )}
                          {s.accelRating > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-app-micro text-app-text/90 w-6">Acc</span>
                              <RatingBar value={s.accelRating} />
                            </div>
                          )}
                          {s.brakingRating > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-app-micro text-app-text/90 w-6">Brk</span>
                              <RatingBar value={s.brakingRating} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Card detail modal */}
          {detailCar && (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-app-bg/70 pt-12 pb-4 px-4 overflow-auto" onClick={() => setDetailCar(null)}>
              <div className="bg-app-bg border border-app-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
                  <div className="flex items-center gap-2">
                    {detailCar.specs?.pi && <PiBadge showNumber={false} pi={detailCar.specs.pi} />}
                    <span className="text-sm font-bold text-app-text/90">{detailCar.name}</span>
                  </div>
                  <Button type="button" variant="app-ghost" size="icon-sm" onClick={() => setDetailCar(null)} className="!h-auto !w-auto p-1 text-app-text/90 hover:text-app-text" aria-label={m.common_close()}>
                    ×
                  </Button>
                </div>
                <CarDetail car={detailCar} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
              </div>
            </div>
          )}
        </>
      ) : (
        <Table>
          <THead>
            <TH className="w-8 px-4" />
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="name" label="Car" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="pi" label="PI" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="hp" label="HP" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="torque" label="Torque" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="weightKg" label={isMetric ? "Wt (kg)" : "Wt (lb)"} />
            </TH>
            <TH>{m.cars_drive_label()}</TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="topSpeedMph" label={`Top Spd (${units.speedLabel})`} />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="zeroToSixty" label="0–60" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="zeroToHundred" label="0–100" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="braking60" label={isMetric ? "Brk 60 (m)" : "Brk 60 (ft)"} />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="speedRating" label="Spd" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="brakingRating" label="Brk" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="handlingRating" label="Hdl" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="accelRating" label="Acc" />
            </TH>
            <TH>
              <ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="division" label="Division" />
            </TH>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={16} className="text-center py-12 text-app-text/90 text-sm">
                  {m.cars_no_match()}
                </td>
              </tr>
            ) : (
              filtered.map((car) => (
                <Fragment key={car.ordinal}>
                  <TRow
                    onClick={() =>
                      setExpanded((prev) => {
                        const s = new Set(prev);
                        if (s.has(car.ordinal)) s.delete(car.ordinal);
                        else s.add(car.ordinal);
                        return s;
                      })
                    }
                    className={selected.has(car.ordinal) ? "bg-app-accent/5" : ""}
                  >
                    <TD className="px-4 w-8">
                      <div onClick={(e) => toggleSelect(car.ordinal, e)} className="flex items-center justify-center">
                        <input type="checkbox" checked={selected.has(car.ordinal)} onChange={() => {}} className="w-3.5 h-3.5 accent-app-accent cursor-pointer" />
                      </div>
                    </TD>
                    <TD>
                      <span className="text-xs text-app-text/90 truncate">{car.name}</span>
                    </TD>
                    <TD className="tabular-nums text-xs text-app-text/90">
                      {car.specs?.pi ? (
                        <>
                          <span className="text-(--badge-color)" data-pi-class={piClass(car.specs.pi)}>
                            {piClass(car.specs.pi)}&nbsp;
                          </span>
                          {car.specs.pi}
                        </>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.hp || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.torque || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{fmtWeight(car.specs?.weightKg ?? 0, car.specs?.weightLbs ?? 0)}</TD>
                    <TD className="text-xs text-app-text/90">{car.specs?.drivetrain || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{fmtSpeed(car.specs?.topSpeedMph ?? 0)}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.zeroToSixty ? `${car.specs.zeroToSixty}s` : "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.zeroToHundred ? `${car.specs.zeroToHundred}s` : "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{fmtBrake(car.specs?.braking60 ?? 0)}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.speedRating || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.brakingRating || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.handlingRating || "—"}</TD>
                    <TD className="tabular-nums text-xs text-app-text/90">{car.specs?.accelRating || "—"}</TD>
                    <TD className="text-xs text-app-text/90 truncate">{car.specs?.division || "—"}</TD>
                  </TRow>
                  {expanded.has(car.ordinal) && (
                    <tr>
                      <td colSpan={16} className="p-0 border-b border-app-border/40">
                        <CarDetail car={car} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </TBody>
        </Table>
      )}

      {/* Floating compare bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-app-surface border border-app-border rounded-full px-4 py-2 shadow-xl">
          <span className="text-xs text-app-text/90">
            {selected.size} {m.cars_selected()}
          </span>
          <Button
            type="button"
            variant="app-outline"
            size="app-sm"
            onClick={() => setComparing(true)}
            disabled={selected.size < 2}
            className="!h-auto !rounded-full !border-app-accent/30 !px-3 !py-1 text-xs font-semibold text-app-accent bg-app-accent/20 hover:bg-app-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m.cars_compare_button()} ({selected.size})
          </Button>
          <Button type="button" variant="app-ghost" size="app-sm" onClick={() => setSelected(new Set())} className="!h-auto !rounded-full !px-0 text-xs text-app-text/90 hover:text-app-text">
            {m.common_clear()}
          </Button>
        </div>
      )}

      {/* Compare modal */}
      {comparing && selectedCars.length >= 2 && (
        <CompareModal cars={selectedCars} onClose={() => setComparing(false)} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
      )}
    </div>
  );
}
