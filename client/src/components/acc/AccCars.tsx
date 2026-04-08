import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

interface AccCarSpecs {
  maxRpm: number;
  hp: number;
  weightKg: number;
  engine: string;
  drivetrain: string;
}

interface AccCar {
  id: number;
  name: string;
  class: string;
  specs: AccCarSpecs | null;
}

const CLASS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  GT3: { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/20" },
  GT4: { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/20" },
  GTC: { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/20" },
  TCX: { bg: "bg-purple-500/15", text: "text-purple-400", border: "border-purple-500/20" },
};

function classColor(cls: string) {
  return CLASS_COLORS[cls] ?? { bg: "bg-app-surface-alt/20", text: "text-app-text-dim", border: "border-app-border" };
}

const BRAND_COLORS: Record<string, string> = {
  "Porsche": "#c4a035",
  "Mercedes-AMG": "#00d2be",
  "Ferrari": "#dc0000",
  "Audi": "#bb0a30",
  "Lamborghini": "#ddb321",
  "McLaren": "#ff8000",
  "Nissan": "#c3002f",
  "BMW": "#0066b1",
  "Bentley": "#333333",
  "Aston": "#006f62",
  "Emil": "#1a1a2e",
  "Lexus": "#1a1a1a",
  "Honda": "#cc0000",
  "Alpine": "#0090ff",
  "Chevrolet": "#d4af37",
  "Ginetta": "#003399",
  "KTM": "#ff6600",
  "Maserati": "#00205b",
};

function getBrandColor(name: string): string {
  for (const [brand, color] of Object.entries(BRAND_COLORS)) {
    if (name.startsWith(brand)) return color;
  }
  return "#555555";
}

function getManufacturer(name: string): string {
  if (name.startsWith("Aston Martin")) return "Aston Martin";
  if (name.startsWith("Mercedes-AMG")) return "Mercedes-AMG";
  if (name.startsWith("Emil Frey")) return "Emil Frey";
  return name.split(" ")[0];
}

function BrandBadge({ brand }: { brand: string }) {
  const color = getBrandColor(brand);
  const abbr = brand === "Mercedes-AMG" ? "AMG"
    : brand === "Aston Martin" ? "AM"
    : brand === "Lamborghini" ? "LAM"
    : brand === "Emil Frey" ? "EF"
    : brand === "Chevrolet" ? "CHV"
    : brand.slice(0, 3).toUpperCase();

  return (
    <div
      className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
      style={{ backgroundColor: color + "20", borderColor: color + "40", borderWidth: 1 }}
    >
      <span className="text-[9px] font-black tracking-tight" style={{ color }}>{abbr}</span>
    </div>
  );
}

type SortKey = "name";

export function AccCars() {
  const { data: cars = [], isLoading } = useQuery<AccCar[]>({
    queryKey: ["acc-cars"],
    queryFn: () => client.api.acc.cars.$get().then((r) => r.json()),
  });

  const [filterClass, setFilterClass] = useState<string | null>(null);
  const [sortKey] = useState<SortKey>("name");
  const [sortAsc] = useState(true);

  const classes = useMemo(() => {
    const set = new Set(cars.map((c) => c.class));
    return Array.from(set).sort();
  }, [cars]);

  const filtered = useMemo(() => {
    let result = cars;
    if (filterClass) result = result.filter((c) => c.class === filterClass);
    // Sort
    result = [...result].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      return sortAsc ? cmp : -cmp;
    });
    return result;
  }, [cars, filterClass, sortKey, sortAsc]);

  const grouped = useMemo(() => {
    const map = new Map<string, AccCar[]>();
    for (const car of filtered) {
      const list = map.get(car.class) ?? [];
      list.push(car);
      map.set(car.class, list);
    }
    return map;
  }, [filtered]);


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-app-text-dim">
        Loading cars...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Filters & Sort */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          <button
            className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
              !filterClass ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"
            }`}
            onClick={() => setFilterClass(null)}
          >
            All
          </button>
          {classes.map((cls) => {
            const c = classColor(cls);
            const count = cars.filter((car) => car.class === cls).length;
            return (
              <button
                key={cls}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                  filterClass === cls ? `${c.bg} ${c.text}` : "text-app-text-muted hover:text-app-text-secondary"
                }`}
                onClick={() => setFilterClass(filterClass === cls ? null : cls)}
              >
                {cls} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Car grid by class */}
      {Array.from(grouped.entries()).map(([cls, classCars]) => {
        const c = classColor(cls);
        return (
          <div key={cls}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${c.bg} ${c.text}`}>{cls}</span>
              <span className="text-xs text-app-text-dim">{classCars.length} cars</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {classCars.map((car) => {
                const brand = getManufacturer(car.name);
                const brandColor = getBrandColor(car.name);
                const specs = car.specs;
                return (
                  <div
                    key={car.id}
                    className="group relative bg-app-surface-alt/20 rounded-lg border border-app-border/10 overflow-hidden hover:border-app-border/30 transition-all"
                  >
                    <div className="h-0.5" style={{ backgroundColor: brandColor }} />
                    {/* Car image */}
                    <div className="relative w-full h-48 overflow-hidden bg-app-surface-alt/10">
                      <img
                        src={`/car-images/acc-${car.id}.jpg`}
                        alt={car.name}
                        className="w-full h-full object-cover object-center"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                      <span className={`absolute bottom-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded ${c.bg} ${c.text}`}>
                        {car.class}
                      </span>
                    </div>
                    <div className="p-3">
                      <div className="flex items-center gap-3 mb-2">
                        <BrandBadge brand={brand} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-app-text leading-tight">{car.name}</div>
                          <div className="text-[10px] text-app-text-dim mt-0.5">{brand}</div>
                        </div>
                      </div>

                      {specs && (
                        <div className="flex items-center gap-3 pt-2 border-t border-app-border/10 text-xs text-app-text-secondary">
                          <span>{specs.engine}</span>
                          <span className="font-mono">{specs.maxRpm.toLocaleString()} RPM</span>
                          <span>{specs.drivetrain}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && (
        <div className="text-center text-app-text-dim py-8">
          No cars match your filters.
        </div>
      )}
    </div>
  );
}
