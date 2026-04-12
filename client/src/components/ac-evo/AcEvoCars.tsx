import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

interface AcEvoCar {
  id: number;
  name: string;
  class: string;
}

const CLASS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  GT3:  { bg: "bg-blue-500/15",    text: "text-blue-400",    border: "border-blue-500/20" },
  Road: { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/20" },
};

function classColor(cls: string) {
  return CLASS_COLORS[cls] ?? { bg: "bg-app-surface-alt/20", text: "text-app-text-dim", border: "border-app-border" };
}

const BRAND_COLORS: Record<string, string> = {
  "Ferrari":       "#dc0000",
  "Lamborghini":   "#ddb321",
  "BMW":           "#0066b1",
  "McLaren":       "#ff8000",
  "Porsche":       "#c4a035",
  "Mercedes-AMG":  "#00d2be",
  "Audi":          "#bb0a30",
  "Honda":         "#cc0000",
  "Alfa Romeo":    "#900000",
  "Abarth":        "#e04000",
  "Lotus":         "#b9cc00",
  "Toyota":        "#eb0a1e",
};

function getBrandColor(name: string): string {
  for (const [brand, color] of Object.entries(BRAND_COLORS)) {
    if (name.startsWith(brand)) return color;
  }
  return "#555";
}

function getManufacturer(name: string): string {
  return name.split(" ")[0];
}

export function AcEvoCars() {
  const { data: cars = [], isLoading } = useQuery<AcEvoCar[]>({
    queryKey: ["ac-evo-cars"],
    queryFn: () => client.api["ac-evo"].cars.$get().then((r) => r.json()),
  });

  const [filterClass, setFilterClass] = useState<string | null>(null);

  const classes = useMemo(() => {
    const set = new Set(cars.map((c) => c.class));
    return Array.from(set).sort();
  }, [cars]);

  const filtered = useMemo(() => {
    let result = cars;
    if (filterClass) result = result.filter((c) => c.class === filterClass);
    return [...result].sort((a, b) => a.name.localeCompare(b.name));
  }, [cars, filterClass]);

  const grouped = useMemo(() => {
    const map = new Map<string, AcEvoCar[]>();
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
      {/* Filters */}
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
                const brandColor = getBrandColor(car.name);
                return (
                  <div
                    key={car.id}
                    className="group relative bg-app-surface-alt/20 rounded-lg border border-app-border/10 overflow-hidden hover:border-app-border/30 transition-all"
                  >
                    <div className="h-0.5" style={{ backgroundColor: brandColor }} />
                    {/* Car image */}
                    <div className="relative w-full h-48 overflow-hidden bg-app-surface-alt/10">
                      <img
                        src={`/car-images/ac-evo-${car.id}.jpg`}
                        alt={car.name}
                        className="w-full h-full object-cover object-center"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                      <span className={`absolute bottom-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded ${c.bg} ${c.text}`}>
                        {cls}
                      </span>
                    </div>
                    <div className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-app-text-primary leading-tight">
                            {car.name}
                          </div>
                          <div className="text-xs text-app-text-muted mt-0.5">
                            {getManufacturer(car.name)}
                          </div>
                        </div>
                        <span className={`shrink-0 text-xs font-bold px-1.5 py-0.5 rounded ${c.bg} ${c.text}`}>
                          {cls}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
