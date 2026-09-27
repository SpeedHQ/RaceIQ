import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { errorFromResponse } from "../../lib/rpc-error";
import { AppInput } from "../ui/AppInput";
import { Button } from "../ui/button";
interface LMUCatalogCar {
  id: string | null;
  ordinal: number | null;
  name: string;
  class?: string;
  series?: string[];
  imageUrl?: string;
}

function categoryLabel(category: string): string {
  return category
    .split(/[_\s]+/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function LMUCars() {
  const [search, setSearch] = useState("");
  const [filterClass, setFilterClass] = useState<string | null>(null);
  const { data: cars = [], isLoading } = useQuery<LMUCatalogCar[]>({
    queryKey: ["cars", "lmu"],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "lmu" } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<LMUCatalogCar[]>;
    },
    staleTime: Infinity,
  });

  const classes = useMemo(() => [...new Set(cars.map((car) => car.class).filter((value): value is string => !!value))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))), [cars]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cars
      .filter((car) => (!filterClass || car.class === filterClass) && (!query || car.name.toLowerCase().includes(query) || car.series?.some((series) => series.toLowerCase().includes(query))))
      .toSorted((left, right) => left.name.localeCompare(right.name) || (left.id ?? "").localeCompare(right.id ?? "") || (left.ordinal ?? 0) - (right.ordinal ?? 0));
  }, [cars, filterClass, search]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <AppInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full @3xl/workspace:w-72" />
        {!isLoading && <span className="text-xs text-app-text/90 whitespace-nowrap">{filtered.length} / {cars.length}</span>}
      </div>

      {!isLoading && (
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            type="button"
            aria-pressed={filterClass === null}
            className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${filterClass === null ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"}`}
            onClick={() => setFilterClass(null)}
          >
            All classes ({cars.length})
          </Button>
          {classes.map((carClass) => {
            const count = cars.filter((car) => car.class === carClass).length;
            return (
              <Button
                type="button"
                key={carClass}
                data-catalog-category={carClass}
                aria-pressed={filterClass === carClass}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${filterClass === carClass ? "catalog-category" : "text-app-text-muted hover:text-app-text-secondary"}`}
                onClick={() => setFilterClass(filterClass === carClass ? null : carClass)}
              >
                {categoryLabel(carClass)} ({count})
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
          {filtered.map((car) => (
            <article key={car.id ?? `discovered-${car.ordinal}`} className="group overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 transition-colors hover:border-app-border-hover/30">
              <div className="relative h-40 overflow-hidden bg-gradient-to-br from-app-text/10 via-app-surface-alt/20 to-app-bg/20">
                <div className="absolute inset-0 flex items-center justify-center text-3xl font-black italic text-app-text/10">LMU</div>
                {car.imageUrl && <img src={car.imageUrl} alt={car.name} loading="lazy" className="relative h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                {car.class && <span className="catalog-category-badge absolute bottom-2 right-2 rounded border px-2 py-0.5 text-app-caption font-bold shadow-sm backdrop-blur-sm" data-catalog-category={car.class}>{categoryLabel(car.class)}</span>}
              </div>
              <div className="p-3">
                <h2 className="text-sm font-semibold leading-tight text-app-text">{car.name}</h2>
                {car.series && car.series.length > 0 && <p className="mt-1 text-xs text-app-text-muted">{car.series.join(" · ")}</p>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
