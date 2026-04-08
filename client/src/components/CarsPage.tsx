import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect, Fragment } from "react";
import { useUnits } from "../hooks/useUnits";
import { getCarModel, loadCarModelConfigs } from "../data/car-models";
import { piClass, PI_COLORS, PiBadge } from "./forza/PiBadge";
import { client } from "../lib/rpc";
import { AppInput } from "./ui/AppInput";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";

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

type SortKey = "name" | "pi" | "hp" | "torque" | "weightKg" | "topSpeedMph" | "zeroToSixty" | "zeroToHundred" | "braking60" | "speedRating" | "brakingRating" | "handlingRating" | "accelRating" | "division";

const PI_CLASSES = ["D", "C", "B", "A", "S", "R", "P", "X"];
const DRIVETRAINS = ["FWD", "RWD", "AWD"];

// piClass, PI_COLORS, PiBadge imported from ../components/PiBadge

function RatingBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-app-border rounded-full overflow-hidden">
        <div className="h-full bg-app-accent rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-app-text/90-muted w-5">{value.toFixed(1)}</span>
    </div>
  );
}

function CarDetail({ car, fmtSpeed, fmtBrake, fmtWeight, isMetric }: {
  car: Car;
  fmtSpeed: (mph: number) => string;
  fmtBrake: (ft: number) => string;
  fmtWeight: (kg: number, lbs: number) => string;
  isMetric: boolean;
}) {
  const s = car.specs;
  if (!s) return <div className="px-4 py-3 text-xs text-app-text/90-muted">No detailed stats available for this car.</div>;

  return (
    <div className="px-4 py-3 grid grid-cols-[200px_1fr] gap-4 bg-app-bg border-t border-app-border">
      {/* Image */}
      <div className="flex flex-col gap-2">
        {s.imageUrl ? (
          <img
            src={s.imageUrl}
            alt={car.name}
            loading="lazy"
            className="w-full rounded object-contain bg-app-surface p-2"
            style={{ maxHeight: 120 }}
          />
        ) : (
          <div className="w-full h-24 rounded bg-app-surface flex items-center justify-center text-xs text-app-text/90-muted">No image</div>
        )}
        {s.synopsis && (
          <p className="text-[11px] text-app-text/90-muted leading-relaxed line-clamp-4">{s.synopsis}</p>
        )}
        {s.wikiUrl && (
          <a
            href={s.wikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-app-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Forza Wiki ↗
          </a>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-xs">
        {/* Engine */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text/90-muted font-semibold">Engine</div>
          <div className="text-app-text/90">{s.engine || "—"} {s.displacement > 0 ? `${s.displacement}L` : ""}</div>
          <div className="text-app-text/90">{s.hp > 0 ? `${s.hp} hp` : "—"} / {s.torque > 0 ? `${s.torque} lb-ft` : "—"}</div>
          <div className="text-app-text/90 capitalize">{s.aspiration || "—"} · {s.gears > 0 ? `${s.gears}-speed` : "—"}</div>
          <div className="text-app-text/90">{s.drivetrain} · {s.frontWeightPct > 0 ? `${s.frontWeightPct}/${100 - s.frontWeightPct} F/R` : ""}</div>
          <div className="text-app-text/90">{fmtWeight(s.weightKg, s.weightLbs)}</div>
        </div>

        {/* Performance */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text/90-muted font-semibold">Performance</div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">Top Speed</span><span className="text-app-text/90 tabular-nums">{fmtSpeed(s.topSpeedMph)}</span></div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">{isMetric ? "0–100 km/h" : "0–60 mph"}</span><span className="text-app-text/90 tabular-nums">{s.zeroToSixty > 0 ? `${s.zeroToSixty}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">{isMetric ? "0–160 km/h" : "0–100 mph"}</span><span className="text-app-text/90 tabular-nums">{s.zeroToHundred > 0 ? `${s.zeroToHundred}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">¼ mile</span><span className="text-app-text/90 tabular-nums">{s.quarterMile > 0 ? `${s.quarterMile}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">60–0 brake</span><span className="text-app-text/90 tabular-nums">{fmtBrake(s.braking60)}</span></div>
          <div className="flex justify-between"><span className="text-app-text/90-muted">Lateral G</span><span className="text-app-text/90 tabular-nums">{s.lateralG60 > 0 ? `${s.lateralG60}g` : "—"}</span></div>
        </div>

        {/* Ratings */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text/90-muted font-semibold">Ratings</div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90-muted w-16">Speed</span>
            <RatingBar value={s.speedRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90-muted w-16">Braking</span>
            <RatingBar value={s.brakingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90-muted w-16">Handling</span>
            <RatingBar value={s.handlingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text/90-muted w-16">Accel</span>
            <RatingBar value={s.accelRating} />
          </div>
          <div className="mt-1 text-[10px] text-app-text/90-muted">
            {s.division && <span className="mr-2">{s.division}</span>}
            {s.price > 0 && <span>{s.price.toLocaleString()} CR</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CompareModal({ cars, onClose, fmtSpeed, fmtBrake, fmtWeight, isMetric }: {
  cars: Car[];
  onClose: () => void;
  fmtSpeed: (mph: number) => string;
  fmtBrake: (ft: number) => string;
  fmtWeight: (kg: number, lbs: number) => string;
  isMetric: boolean;
}) {
  type StatRow = { label: string; getValue: (s: CarSpecs) => string; highlight?: "low" | "high" };
  const rows: StatRow[] = [
    { label: "PI", getValue: s => s.pi > 0 ? `${piClass(s.pi)} ${s.pi}` : "—" },
    { label: "Division", getValue: s => s.division || "—" },
    { label: "Drivetrain", getValue: s => s.drivetrain || "—" },
    { label: "Engine", getValue: s => s.engine ? `${s.engine}${s.displacement > 0 ? ` ${s.displacement}L` : ""}` : "—" },
    { label: "Aspiration", getValue: s => s.aspiration || "—" },
    { label: "Gears", getValue: s => s.gears > 0 ? `${s.gears}-speed` : "—" },
    { label: "HP", getValue: s => s.hp > 0 ? `${s.hp}` : "—", highlight: "high" },
    { label: "Torque (lb-ft)", getValue: s => s.torque > 0 ? `${s.torque}` : "—", highlight: "high" },
    { label: "Weight", getValue: s => fmtWeight(s.weightKg, s.weightLbs), highlight: "low" },
    { label: "Front Weight %", getValue: s => s.frontWeightPct > 0 ? `${s.frontWeightPct}%` : "—" },
    { label: `Top Speed (${isMetric ? "km/h" : "mph"})`, getValue: s => fmtSpeed(s.topSpeedMph), highlight: "high" },
    { label: isMetric ? "0–100 km/h" : "0–60 mph", getValue: s => s.zeroToSixty > 0 ? `${s.zeroToSixty}s` : "—", highlight: "low" },
    { label: isMetric ? "0–160 km/h" : "0–100 mph", getValue: s => s.zeroToHundred > 0 ? `${s.zeroToHundred}s` : "—", highlight: "low" },
    { label: "¼ Mile", getValue: s => s.quarterMile > 0 ? `${s.quarterMile}s` : "—", highlight: "low" },
    { label: `60–0 Brake (${isMetric ? "m" : "ft"})`, getValue: s => fmtBrake(s.braking60), highlight: "low" },
    { label: "Lateral G", getValue: s => s.lateralG60 > 0 ? `${s.lateralG60}g` : "—", highlight: "high" },
    { label: "Speed Rating", getValue: s => s.speedRating > 0 ? s.speedRating.toFixed(1) : "—", highlight: "high" },
    { label: "Braking Rating", getValue: s => s.brakingRating > 0 ? s.brakingRating.toFixed(1) : "—", highlight: "high" },
    { label: "Handling Rating", getValue: s => s.handlingRating > 0 ? s.handlingRating.toFixed(1) : "—", highlight: "high" },
    { label: "Accel Rating", getValue: s => s.accelRating > 0 ? s.accelRating.toFixed(1) : "—", highlight: "high" },
    { label: "Price (CR)", getValue: s => s.price > 0 ? s.price.toLocaleString() : "—" },
  ];

  // Determine best values for numeric highlighting
  function getBestIdx(row: StatRow): number[] {
    if (!row.highlight) return [];
    const vals = cars.map(c => {
      const raw = c.specs ? row.getValue(c.specs) : "—";
      const n = parseFloat(raw.replace(/[^0-9.-]/g, ""));
      return isNaN(n) ? null : n;
    });
    const valid = vals.filter((v): v is number => v !== null);
    if (valid.length < 2) return [];
    const best = row.highlight === "high" ? Math.max(...valid) : Math.min(...valid);
    return vals.map((v, i) => v === best ? i : -1).filter(i => i >= 0);
  }

  const colWidth = Math.max(180, Math.floor(560 / cars.length));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-8 pb-4 px-4 overflow-auto" onClick={onClose}>
      <div
        className="bg-app-bg border border-app-border rounded-xl shadow-2xl w-full overflow-auto"
        style={{ maxWidth: 160 + colWidth * cars.length, maxHeight: "90vh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border sticky top-0 bg-app-bg z-10">
          <h2 className="text-sm font-bold text-app-text/90">Compare Cars</h2>
          <button onClick={onClose} className="text-app-text/90-muted hover:text-app-text/90 text-lg leading-none">×</button>
        </div>

        <div className="overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-app-border">
                <th className="text-left px-4 py-2 text-app-text/90-muted font-medium sticky left-0 bg-app-bg" style={{ minWidth: 160 }}>Stat</th>
                {cars.map(car => (
                  <th key={car.ordinal} className="px-3 py-2 text-center" style={{ minWidth: colWidth }}>
                    {car.specs?.imageUrl && (
                      <img src={car.specs.imageUrl} alt={car.name} loading="lazy" className="h-14 w-full object-contain mx-auto mb-1" />
                    )}
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
                    <td className="px-4 py-1.5 text-app-text/90-muted sticky left-0 bg-inherit font-medium" style={{ minWidth: 160 }}>{row.label}</td>
                    {cars.map((car, ci) => {
                      const val = car.specs ? row.getValue(car.specs) : "—";
                      const isBest = bestIdxs.includes(ci);
                      return (
                        <td key={car.ordinal} className={`px-3 py-1.5 text-center tabular-nums ${isBest ? "text-green-400 font-semibold" : "text-app-text/90"}`}>
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
    <button onClick={() => onSort(k)}
      className={`text-left text-[10px] uppercase tracking-wider font-semibold transition-colors ${active ? "text-app-accent" : "text-app-text/90-muted hover:text-app-text/90"} ${className}`}>
      {label}{active ? (sortDir === 1 ? " ↑" : " ↓") : ""}
    </button>
  );
}

export function CarsPage() {
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as { compare?: string };
  const [configsReady, setConfigsReady] = useState(false);
  useEffect(() => { loadCarModelConfigs().then(() => setConfigsReady(true)); }, []);
  const units = useUnits();
  const isMetric = units.unit === "metric";
  function fmtSpeed(mph: number)          { return mph  ? `${units.fromMph(mph).toFixed(1)} ${units.speedLabel}` : "—"; }
  function fmtBrake(ft: number)           { return ft   ? `${isMetric ? (ft * 0.3048).toFixed(1) + " m" : ft + " ft"}` : "—"; }
  function fmtWeight(kg: number, lbs: number) { return kg ? `${isMetric ? kg + " kg" : lbs + " lb"}` : "—"; }

  const { data: cars = [], isLoading } = useQuery<Car[]>({
    queryKey: ["cars"],
    queryFn: () => client.api.cars.$get().then((r) => r.json()),
    staleTime: 60_000,
  });

  // Parse ?compare=1,2,3 from URL
  const compareParam = searchParams.compare;
  const initialCompareIds = useMemo(() => {
    if (!compareParam) return null;
    return new Set(compareParam.split(",").map(Number).filter(n => !isNaN(n)));
  }, [compareParam]);

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [driveFilter, setDriveFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(() => initialCompareIds ?? new Set());
  const [comparing, setComparing] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
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
      list = list.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.specs?.division?.toLowerCase().includes(q) ||
        c.specs?.engine?.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (sort === "name") return sortDir * a.name.localeCompare(b.name);
      if (sort === "division") return sortDir * (a.specs?.division ?? "").localeCompare(b.specs?.division ?? "");
      const av = a.specs?.[sort] ?? -Infinity;
      const bv = b.specs?.[sort] ?? -Infinity;
      return sortDir * ((av as number) - (bv as number));
    });
  }, [cars, search, classFilter, driveFilter, sort, sortDir]);

  const carMap = useMemo(() => new Map(cars.map(c => [c.ordinal, c])), [cars]);
  const selectedCars = useMemo(() => [...selected].map(id => carMap.get(id)).filter((c): c is Car => !!c), [selected, carMap]);

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSort(key); setSortDir(key === "name" ? 1 : -1); }
  }

  function toggleSelect(ordinal: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(prev => { const s = new Set(prev); if (s.has(ordinal)) s.delete(ordinal); else s.add(ordinal); return s; });
  }


  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center flex-wrap gap-2">
        {/* View mode toggle */}
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          <button
            onClick={() => setViewMode("table")}
            title="Table view"
            className={`px-2.5 py-1.5 transition-colors ${viewMode === "table" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>
            </svg>
          </button>
          <button
            onClick={() => setViewMode("grid")}
            title="Grid view"
            className={`px-2.5 py-1.5 transition-colors ${viewMode === "grid" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
        </div>

        <AppInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, division, engine..."
          className="w-52"
        />

        <div className="flex items-center gap-1">
          {PI_CLASSES.map((cls) => (
            <button key={cls} onClick={() => setClassFilter(classFilter === cls ? null : cls)}
              className={`text-xs font-bold px-3 py-1.5 rounded transition-colors ${classFilter === cls ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90 border border-app-border"}`}>
              {cls}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {DRIVETRAINS.map((d) => (
            <button key={d} onClick={() => setDriveFilter(driveFilter === d ? null : d)}
              className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${driveFilter === d ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90-muted hover:text-app-text/90 border border-app-border"}`}>
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Table / Grid */}
      {isLoading ? (
        <div className="text-center py-16 text-app-text/90-muted text-sm">Loading cars...</div>
      ) : viewMode === "grid" ? (
        <>
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-app-text/90-muted text-sm">No cars match filters</div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {filtered.map(car => {
                const s = car.specs!;
                const isSel = selected.has(car.ordinal);
                return (
                  <div
                    key={car.ordinal}
                    onClick={() => setDetailCar(car)}
                    className={`relative rounded-xl border cursor-pointer transition-all hover:border-app-accent/50 hover:shadow-md ${isSel ? "border-app-accent bg-app-accent/5" : "border-app-border bg-app-surface"}`}
                  >
                    {/* Checkbox */}
                    <div
                      onClick={e => toggleSelect(car.ordinal, e)}
                      className="absolute top-2 left-2 z-10"
                    >
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => {}}
                        className="w-3.5 h-3.5 accent-app-accent cursor-pointer"
                      />
                    </div>

                    {/* Image */}
                    <div className="h-32 flex items-center justify-center bg-app-bg rounded-t-xl overflow-hidden px-3 pt-3 relative">
                      {s.imageUrl ? (
                        <img src={s.imageUrl} alt={car.name} loading="lazy" className="h-full w-full object-contain" />
                      ) : (
                        <div className="text-xs text-app-text/90-muted">No image</div>
                      )}
                      {configsReady && getCarModel(car.ordinal).hasModel && (
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate({ to: "/fm23/cars/$carOrdinal", params: { carOrdinal: String(car.ordinal) } }); }}
                          className="absolute top-2 right-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-cyan-600/80 hover:bg-cyan-500 text-white border border-cyan-400/30 transition-colors"
                          title="View 3D model"
                        >
                          3D
                        </button>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-3 space-y-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {s.pi > 0 && <PiBadge showNumber={false} pi={s.pi} />}
                          <span className={`text-[10px] font-semibold ${PI_COLORS[piClass(s.pi)]?.split(" ")[1] ?? "text-app-text/90-muted"}`}>{s.pi || ""}</span>
                        </div>
                        <div className="text-xs font-semibold text-app-text/90 leading-tight mt-0.5 line-clamp-2">{car.name}</div>
                        <div className="text-[10px] text-app-text/90-muted mt-0.5">{s.division || "—"} · {s.drivetrain || "—"}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                        <div className="flex justify-between"><span className="text-app-text/90-muted">HP</span><span className="tabular-nums text-app-text/90">{s.hp || "—"}</span></div>
                        <div className="flex justify-between"><span className="text-app-text/90-muted">Torque</span><span className="tabular-nums text-app-text/90">{s.torque || "—"}</span></div>
                        <div className="flex justify-between"><span className="text-app-text/90-muted">Top Spd</span><span className="tabular-nums text-app-text/90">{fmtSpeed(s.topSpeedMph)}</span></div>
                        <div className="flex justify-between"><span className="text-app-text/90-muted">0–60</span><span className="tabular-nums text-app-text/90">{s.zeroToSixty ? `${s.zeroToSixty}s` : "—"}</span></div>
                        <div className="flex justify-between"><span className="text-app-text/90-muted">Weight</span><span className="tabular-nums text-app-text/90">{fmtWeight(s.weightKg, s.weightLbs)}</span></div>
                        <div className="flex justify-between"><span className="text-app-text/90-muted">Brake 60</span><span className="tabular-nums text-app-text/90">{fmtBrake(s.braking60)}</span></div>
                      </div>

                      {(s.speedRating > 0 || s.handlingRating > 0) && (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                          {s.speedRating > 0 && <div className="flex items-center gap-1"><span className="text-[9px] text-app-text/90-muted w-6">Spd</span><RatingBar value={s.speedRating} /></div>}
                          {s.handlingRating > 0 && <div className="flex items-center gap-1"><span className="text-[9px] text-app-text/90-muted w-6">Hdl</span><RatingBar value={s.handlingRating} /></div>}
                          {s.accelRating > 0 && <div className="flex items-center gap-1"><span className="text-[9px] text-app-text/90-muted w-6">Acc</span><RatingBar value={s.accelRating} /></div>}
                          {s.brakingRating > 0 && <div className="flex items-center gap-1"><span className="text-[9px] text-app-text/90-muted w-6">Brk</span><RatingBar value={s.brakingRating} /></div>}
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
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-12 pb-4 px-4 overflow-auto" onClick={() => setDetailCar(null)}>
              <div className="bg-app-bg border border-app-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
                  <div className="flex items-center gap-2">
                    {detailCar.specs?.pi && <PiBadge showNumber={false} pi={detailCar.specs.pi} />}
                    <span className="text-sm font-bold text-app-text/90">{detailCar.name}</span>
                  </div>
                  <button onClick={() => setDetailCar(null)} className="text-app-text/90-muted hover:text-app-text/90 text-lg leading-none">×</button>
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
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="name" label="Car" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="pi" label="PI" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="hp" label="HP" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="torque" label="Torque" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="weightKg" label={isMetric ? "Wt (kg)" : "Wt (lb)"} /></TH>
            <TH>Drive</TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="topSpeedMph" label={`Top Spd (${units.speedLabel})`} /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="zeroToSixty" label="0–60" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="zeroToHundred" label="0–100" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="braking60" label={isMetric ? "Brk 60 (m)" : "Brk 60 (ft)"} /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="speedRating" label="Spd" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="brakingRating" label="Brk" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="handlingRating" label="Hdl" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="accelRating" label="Acc" /></TH>
            <TH><ColHeader sort={sort} sortDir={sortDir} onSort={toggleSort} k="division" label="Division" /></TH>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              <tr><td colSpan={16} className="text-center py-12 text-app-text/90-muted text-sm">No cars match filters</td></tr>
            ) : filtered.map((car) => (
              <Fragment key={car.ordinal}>
                <TRow
                  onClick={() => setExpanded(prev => { const s = new Set(prev); if (s.has(car.ordinal)) s.delete(car.ordinal); else s.add(car.ordinal); return s; })}
                  className={selected.has(car.ordinal) ? "bg-app-accent/5" : ""}
                >
                  <TD className="px-4 w-8">
                    <div onClick={e => toggleSelect(car.ordinal, e)} className="flex items-center justify-center">
                      <input type="checkbox" checked={selected.has(car.ordinal)} onChange={() => {}} className="w-3.5 h-3.5 accent-app-accent cursor-pointer" />
                    </div>
                  </TD>
                  <TD>
                    <span className="text-xs text-app-text/90 truncate">{car.name}</span>
                  </TD>
                  <TD className="tabular-nums text-xs text-app-text/90">
                    {car.specs?.pi ? <><span className={PI_COLORS[piClass(car.specs.pi)]?.split(" ")[1] ?? "text-app-text/90-muted"}>{piClass(car.specs.pi)}&nbsp;</span>{car.specs.pi}</> : "—"}
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
                  <TD className="text-xs text-app-text/90-muted truncate">{car.specs?.division || "—"}</TD>
                </TRow>
                {expanded.has(car.ordinal) && (
                  <tr><td colSpan={16} className="p-0 border-b border-app-border/40">
                    <CarDetail car={car} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
                  </td></tr>
                )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}

      {/* Floating compare bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-app-surface border border-app-border rounded-full px-4 py-2 shadow-xl">
          <span className="text-xs text-app-text/90-muted">{selected.size} car{selected.size !== 1 ? "s" : ""} selected</span>
          <button
            onClick={() => setComparing(true)}
            disabled={selected.size < 2}
            className="text-xs font-semibold px-3 py-1 rounded-full bg-app-accent/20 text-app-accent border border-app-accent/30 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-app-accent/30 transition-colors"
          >
            Compare ({selected.size})
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-app-text/90-muted hover:text-app-text/90 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Compare modal */}
      {comparing && selectedCars.length >= 2 && (
        <CompareModal
          cars={selectedCars}
          onClose={() => setComparing(false)}
          fmtSpeed={fmtSpeed}
          fmtBrake={fmtBrake}
          fmtWeight={fmtWeight}
          isMetric={isMetric}
        />
      )}
    </div>
  );
}
