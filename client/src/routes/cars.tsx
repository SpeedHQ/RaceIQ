import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";

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
  synopsis: string;
}

interface Car {
  ordinal: number;
  name: string;
  specs?: CarSpecs;
}

type SortKey = "name" | "hp" | "weightKg" | "pi" | "topSpeedMph" | "zeroToSixty" | "torque";

const PI_CLASSES = ["D", "C", "B", "A", "S", "R", "P", "X"];
const DRIVETRAINS = ["FWD", "RWD", "AWD"];

function piClass(pi: number): string {
  if (pi <= 0) return "?";
  if (pi < 500) return "D";
  if (pi < 600) return "C";
  if (pi < 700) return "B";
  if (pi < 800) return "A";
  if (pi < 900) return "S";
  return "X";
}

const PI_COLORS: Record<string, string> = {
  D: "bg-gray-500/20 text-gray-400",
  C: "bg-green-500/20 text-green-400",
  B: "bg-blue-500/20 text-blue-400",
  A: "bg-purple-500/20 text-purple-400",
  S: "bg-amber-500/20 text-amber-400",
  R: "bg-orange-500/20 text-orange-400",
  P: "bg-red-500/20 text-red-400",
  X: "bg-pink-500/20 text-pink-400",
};

function PiBadge({ pi }: { pi: number }) {
  const cls = piClass(pi);
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${PI_COLORS[cls] ?? "bg-app-surface text-app-text-muted"}`}>
      {cls}
    </span>
  );
}

function RatingBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-app-border rounded-full overflow-hidden">
        <div className="h-full bg-app-accent rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-app-text-muted w-5">{value.toFixed(1)}</span>
    </div>
  );
}

function CarDetail({ car }: { car: Car }) {
  const s = car.specs;
  if (!s) return <div className="px-4 py-3 text-xs text-app-text-muted">No detailed stats available for this car.</div>;

  return (
    <div className="px-4 py-3 grid grid-cols-[200px_1fr] gap-4 bg-app-bg border-t border-app-border">
      {/* Image */}
      <div className="flex flex-col gap-2">
        {s.imageUrl ? (
          <img
            src={s.imageUrl}
            alt={car.name}
            className="w-full rounded object-contain bg-app-surface p-2"
            style={{ maxHeight: 120 }}
          />
        ) : (
          <div className="w-full h-24 rounded bg-app-surface flex items-center justify-center text-xs text-app-text-muted">No image</div>
        )}
        {s.synopsis && (
          <p className="text-[11px] text-app-text-muted leading-relaxed line-clamp-4">{s.synopsis}</p>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-xs">
        {/* Engine */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted font-semibold">Engine</div>
          <div className="text-app-text">{s.engine || "—"} {s.displacement > 0 ? `${s.displacement}L` : ""}</div>
          <div className="text-app-text-secondary">{s.hp > 0 ? `${s.hp} hp` : "—"} / {s.torque > 0 ? `${s.torque} lb-ft` : "—"}</div>
          <div className="text-app-text-secondary capitalize">{s.aspiration || "—"} · {s.gears > 0 ? `${s.gears}-speed` : "—"}</div>
          <div className="text-app-text-secondary">{s.drivetrain} · {s.frontWeightPct > 0 ? `${s.frontWeightPct}/${100 - s.frontWeightPct} F/R` : ""}</div>
          <div className="text-app-text-secondary">{s.weightKg > 0 ? `${s.weightKg} kg / ${s.weightLbs} lbs` : "—"}</div>
        </div>

        {/* Performance */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted font-semibold">Performance</div>
          <div className="flex justify-between"><span className="text-app-text-muted">Top Speed</span><span className="text-app-text tabular-nums">{s.topSpeedMph > 0 ? `${s.topSpeedMph} mph` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">0–60 mph</span><span className="text-app-text tabular-nums">{s.zeroToSixty > 0 ? `${s.zeroToSixty}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">0–100 mph</span><span className="text-app-text tabular-nums">{s.zeroToHundred > 0 ? `${s.zeroToHundred}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">¼ mile</span><span className="text-app-text tabular-nums">{s.quarterMile > 0 ? `${s.quarterMile}s` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">60–0 brake</span><span className="text-app-text tabular-nums">{s.braking60 > 0 ? `${s.braking60} ft` : "—"}</span></div>
          <div className="flex justify-between"><span className="text-app-text-muted">Lateral G</span><span className="text-app-text tabular-nums">{s.lateralG60 > 0 ? `${s.lateralG60}g` : "—"}</span></div>
        </div>

        {/* Ratings */}
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted font-semibold">Ratings</div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text-muted w-16">Speed</span>
            <RatingBar value={s.speedRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text-muted w-16">Braking</span>
            <RatingBar value={s.brakingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text-muted w-16">Handling</span>
            <RatingBar value={s.handlingRating} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-app-text-muted w-16">Accel</span>
            <RatingBar value={s.accelRating} />
          </div>
          <div className="mt-1 text-[10px] text-app-text-muted">
            {s.division && <span className="mr-2">{s.division}</span>}
            {s.price > 0 && <span>{s.price.toLocaleString()} CR</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CarsPage() {
  const { data: cars = [], isLoading } = useQuery<Car[]>({
    queryKey: ["cars"],
    queryFn: () => fetch("/api/cars").then((r) => r.json()),
    staleTime: 60_000,
  });

  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [driveFilter, setDriveFilter] = useState<string | null>(null);
  const [specsOnly, setSpecsOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = useMemo(() => {
    let list = cars;
    if (specsOnly) list = list.filter((c) => c.specs);
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
      const av = a.specs?.[sort] ?? -Infinity;
      const bv = b.specs?.[sort] ?? -Infinity;
      return sortDir * ((av as number) - (bv as number));
    });
  }, [cars, search, classFilter, driveFilter, specsOnly, sort, sortDir]);

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSort(key); setSortDir(key === "name" ? 1 : -1); }
  }

  function ColHeader({ k, label, className = "" }: { k: SortKey; label: string; className?: string }) {
    const active = sort === k;
    return (
      <button onClick={() => toggleSort(k)}
        className={`text-left text-[10px] uppercase tracking-wider font-semibold transition-colors ${active ? "text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"} ${className}`}>
        {label}{active ? (sortDir === 1 ? " ↑" : " ↓") : ""}
      </button>
    );
  }

  return (
    <div className="p-4 space-y-3 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-app-text">Cars</h1>
            <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-app-accent/20 text-app-accent">{filtered.length}</span>
          </div>
          <p className="text-xs text-app-text-muted">Forza Motorsport 2023 car database</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, division, engine..."
            className="bg-app-surface text-app-text text-xs rounded-lg px-3 py-1.5 border border-app-border focus:outline-none focus:ring-1 focus:ring-app-accent w-52" />

          <div className="flex items-center gap-1">
            {PI_CLASSES.map((cls) => (
              <button key={cls} onClick={() => setClassFilter(classFilter === cls ? null : cls)}
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors ${classFilter === cls ? "bg-app-accent text-white" : "bg-app-surface text-app-text-muted hover:text-app-text border border-app-border"}`}>
                {cls}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            {DRIVETRAINS.map((d) => (
              <button key={d} onClick={() => setDriveFilter(driveFilter === d ? null : d)}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${driveFilter === d ? "bg-app-accent text-white" : "bg-app-surface text-app-text-muted hover:text-app-text border border-app-border"}`}>
                {d}
              </button>
            ))}
          </div>

          <button onClick={() => setSpecsOnly((v) => !v)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded transition-colors border ${specsOnly ? "bg-app-accent text-white border-app-accent" : "bg-app-surface text-app-text-muted hover:text-app-text border-app-border"}`}>
            Has Stats
          </button>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-16 text-app-text-muted text-sm">Loading cars...</div>
      ) : (
        <div className="rounded-lg border border-app-border overflow-hidden">
          <div className="grid grid-cols-[1fr_52px_70px_72px_60px_72px_60px_110px] gap-x-3 px-4 py-2 bg-app-surface border-b border-app-border">
            <ColHeader k="name" label="Car" />
            <ColHeader k="pi" label="PI" />
            <ColHeader k="hp" label="HP" />
            <ColHeader k="weightKg" label="Weight" />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-app-text-muted">Drive</span>
            <ColHeader k="topSpeedMph" label="Top Spd" />
            <ColHeader k="zeroToSixty" label="0–60" />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-app-text-muted">Division</span>
          </div>

          <div className="divide-y divide-app-border/40">
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-app-text-muted text-sm">No cars match filters</div>
            ) : filtered.map((car) => (
              <div key={car.ordinal}>
                <div
                  onClick={() => setExpanded(expanded === car.ordinal ? null : car.ordinal)}
                  className="grid grid-cols-[1fr_52px_70px_72px_60px_72px_60px_110px] gap-x-3 px-4 py-2.5 hover:bg-app-surface/50 transition-colors items-center cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {car.specs?.pi ? <PiBadge pi={car.specs.pi} /> : <span className="w-6" />}
                    <span className="text-xs text-app-text truncate">{car.name}</span>
                  </div>
                  <span className="text-xs tabular-nums text-app-text-secondary">{car.specs?.pi || "—"}</span>
                  <span className="text-xs tabular-nums text-app-text-secondary">{car.specs?.hp ? `${car.specs.hp} hp` : "—"}</span>
                  <span className="text-xs tabular-nums text-app-text-secondary">{car.specs?.weightKg ? `${car.specs.weightKg} kg` : "—"}</span>
                  <span className="text-xs text-app-text-secondary">{car.specs?.drivetrain || "—"}</span>
                  <span className="text-xs tabular-nums text-app-text-secondary">{car.specs?.topSpeedMph ? `${car.specs.topSpeedMph}` : "—"}</span>
                  <span className="text-xs tabular-nums text-app-text-secondary">{car.specs?.zeroToSixty ? `${car.specs.zeroToSixty}s` : "—"}</span>
                  <span className="text-xs text-app-text-muted truncate">{car.specs?.division || "—"}</span>
                </div>
                {expanded === car.ordinal && <CarDetail car={car} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/cars")({
  component: CarsPage,
});
