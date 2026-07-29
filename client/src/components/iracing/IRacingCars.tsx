import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { errorFromResponse } from "../../lib/rpc-error";
import { AppInput } from "../ui/AppInput";

interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
}

const CATEGORY_COLORS: Record<string, { active: string; badge: string }> = {
  sports_car: {
    active: "bg-blue-500/15 text-blue-400",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  },
  formula_car: {
    active: "bg-purple-500/15 text-purple-400",
    badge: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  },
  oval: {
    active: "bg-amber-500/15 text-amber-400",
    badge: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  },
  dirt_oval: {
    active: "bg-orange-500/15 text-orange-400",
    badge: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  },
  dirt_road: {
    active: "bg-emerald-500/15 text-emerald-400",
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
};

const DEFAULT_CATEGORY_COLOR = {
  active: "bg-app-surface-alt text-app-text-secondary",
  badge: "bg-app-surface-alt/80 text-app-text-secondary border-app-border",
};

function categoryLabel(category: string): string {
  switch (category) {
    case "sports_car":
      return m.iracingcars_category_sports_car();
    case "formula_car":
      return m.iracingcars_category_formula_car();
    case "oval":
      return m.iracingcars_category_oval();
    case "dirt_oval":
      return m.iracingcars_category_dirt_oval();
    case "dirt_road":
      return m.iracingcars_category_dirt_road();
    case "discovered":
      return m.iracingcars_category_discovered();
    default:
      return category
        .split("_")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ");
  }
}

export function IRacingCars() {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const { data: cars = [], isLoading } = useQuery<IRacingCatalogCar[]>({
    queryKey: ["cars", "iracing"],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "iracing" } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<IRacingCatalogCar[]>;
    },
    staleTime: Infinity,
  });

  const categories = useMemo(() => Array.from(new Set(cars.map((car) => car.category))).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))), [cars]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cars.filter(
      (car) => (!filterCategory || car.category === filterCategory) && (!query || car.name.toLowerCase().includes(query) || categoryLabel(car.category).toLowerCase().includes(query)),
    );
  }, [cars, filterCategory, search]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <AppInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full sm:w-72" />
        {!isLoading && (
          <span className="text-xs text-app-text/90-muted whitespace-nowrap">
            {filtered.length} / {cars.length}
          </span>
        )}
      </div>

      {!isLoading && (
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            aria-pressed={filterCategory === null}
            className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
              filterCategory === null ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"
            }`}
            onClick={() => setFilterCategory(null)}
          >
            {m.iracingcars_all_categories()} ({cars.length})
          </button>
          {categories.map((category) => {
            const colors = CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLOR;
            const count = cars.filter((car) => car.category === category).length;
            return (
              <button
                type="button"
                key={category}
                aria-pressed={filterCategory === category}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${filterCategory === category ? colors.active : "text-app-text-muted hover:text-app-text-secondary"}`}
                onClick={() => setFilterCategory(filterCategory === category ? null : category)}
              >
                {categoryLabel(category)} ({count})
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90-muted text-sm">{m.cars_loading()}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-app-text/90-muted text-sm">{m.cars_no_match()}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((car) => {
            const colors = CATEGORY_COLORS[car.category] ?? DEFAULT_CATEGORY_COLOR;
            return (
              <article key={car.ordinal} className="group overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 transition-colors hover:border-app-border/30">
                <div className="relative h-40 overflow-hidden bg-gradient-to-br from-white/10 via-app-surface-alt/20 to-black/20">
                  <div className="absolute inset-0 flex items-center justify-center text-3xl font-black italic text-app-text/10">iR</div>
                  {car.imageUrl && (
                    <img
                      src={car.imageUrl}
                      alt={car.name}
                      loading="lazy"
                      className="relative h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                  <span className={`absolute bottom-2 right-2 rounded border px-2 py-0.5 text-[10px] font-bold shadow-sm backdrop-blur-sm ${colors.badge}`}>{categoryLabel(car.category)}</span>
                </div>
                <div className="p-3">
                  <h2 className="text-sm font-semibold leading-tight text-app-text">{car.name}</h2>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
