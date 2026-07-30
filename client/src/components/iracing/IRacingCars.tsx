import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { errorFromResponse } from "../../lib/rpc-error";
import { AppInput } from "../ui/AppInput";
import { Button } from "../ui/button";

interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
  category: string;
  imageUrl: string;
}

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
        <AppInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full @3xl/workspace:w-72" />
        {!isLoading && (
          <span className="text-xs text-app-text/90 whitespace-nowrap">
            {filtered.length} / {cars.length}
          </span>
        )}
      </div>

      {!isLoading && (
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            type="button"
            aria-pressed={filterCategory === null}
            className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
              filterCategory === null ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"
            }`}
            onClick={() => setFilterCategory(null)}
          >
            {m.iracingcars_all_categories()} ({cars.length})
          </Button>
          {categories.map((category) => {
            const count = cars.filter((car) => car.category === category).length;
            return (
              <Button
                type="button"
                key={category}
                data-catalog-category={category}
                aria-pressed={filterCategory === category}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${filterCategory === category ? "catalog-category" : "text-app-text-muted hover:text-app-text-secondary"}`}
                onClick={() => setFilterCategory(filterCategory === category ? null : category)}
              >
                {categoryLabel(category)} ({count})
              </Button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90 text-sm">{m.cars_loading()}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-app-text/90 text-sm">{m.cars_no_match()}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3 @7xl/workspace:grid-cols-4">
          {filtered.map((car) => {
            return (
              <article key={car.ordinal} className="group overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 transition-colors hover:border-app-border-hover/30">
                <div className="relative h-40 overflow-hidden bg-gradient-to-br from-app-text/10 via-app-surface-alt/20 to-app-bg/20">
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
                  <span
                    className="catalog-category-badge absolute bottom-2 right-2 rounded border px-2 py-0.5 text-app-caption font-bold shadow-sm backdrop-blur-sm"
                    data-catalog-category={car.category}
                  >
                    {categoryLabel(car.category)}
                  </span>
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
