import { sortIRacingCars } from "@raceiq/frontend-pure/iracing-car-sort";
import { useCarsCatalogueHost } from "../host";
import type { CarsCatalogueMessages, IRacingCatalogueCar } from "../../contracts/host";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
export type IRacingCatalogCar = IRacingCatalogueCar;


function categoryLabel(m: CarsCatalogueMessages, category: string): string {
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

export function filterCatalogCars(cars: IRacingCatalogCar[], search: string, filterCategory: string | null, m?: CarsCatalogueMessages) {
  const query = search.trim().toLowerCase();
  return sortIRacingCars(cars.filter((car) =>
    (!filterCategory || car.category === filterCategory) &&
    (!query || car.name.toLowerCase().includes(query) ||
      (car.shortName ?? "").toLowerCase().includes(query) ||
      (car.searchTerms ?? "").toLowerCase().includes(query) ||
      (m ? categoryLabel(m, car.category) : car.category).toLowerCase().includes(query)),
  ));
}

export function IRacingCars({ gameId = "iracing" }: { gameId?: "iracing" | "ams2" }) {
  const { AppInput, SearchSelect, m, useUnits, loadIRacingCars } = useCarsCatalogueHost();
  const units = useUnits();
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const { data: cars = [], isLoading } = useQuery<IRacingCatalogCar[]>({
    queryKey: ["cars", gameId],
    queryFn: () => loadIRacingCars(gameId),
    staleTime: gameId === "ams2" ? 15_000 : Infinity,
    refetchInterval: gameId === "ams2" ? 30_000 : false,
  });

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const car of cars) counts.set(car.category, (counts.get(car.category) ?? 0) + 1);
    return [
      { value: "__all_categories__", label: `${m.iracingcars_all_categories()} (${cars.length})` },
      ...[...counts.keys()]
        .sort((a, b) => categoryLabel(m, a).localeCompare(categoryLabel(m, b)))
        .map((category) => ({ value: category, label: `${categoryLabel(m, category)} (${counts.get(category)})` })),
    ];
  }, [cars, m]);

  const filtered = useMemo(() => filterCatalogCars(cars, search, filterCategory, m), [cars, filterCategory, search, m]);
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <AppInput type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full @3xl/workspace:w-72" />
        {!isLoading && (
          <span className="text-xs text-app-text/90 whitespace-nowrap">
            {filtered.length} / {cars.length}
          </span>
        )}
      </div>

      {!isLoading && (
        <SearchSelect
          clearOnOpen
          value={filterCategory ?? ""}
          onChange={(value) => setFilterCategory(value === "__all_categories__" ? null : value)}
          options={categoryOptions}
          placeholder={`${m.iracingcars_all_categories()} (${cars.length})`}
          ariaLabel={m.iracingcars_all_categories()}
          className="w-full @3xl/workspace:w-72"
        />
      )}

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90 text-sm">{m.cars_loading()}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-app-text/90 text-sm">{m.cars_no_match()}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3 @7xl/workspace:grid-cols-4">
          {filtered.map((car) => <CatalogCarCard key={car.id} car={car} gameId={gameId} unit={units.unit} m={m} />)}
        </div>
      )}
    </div>
  );
}


export function CatalogCarCard({ car, gameId, unit, m }: { m: CarsCatalogueMessages; car: IRacingCatalogCar; gameId: "iracing" | "ams2"; unit: "metric" | "imperial" }) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(car.imageUrl?.trim()) && !imageFailed;
  const specifications: string[] = [];
  if (typeof car.hp === "number" && Number.isFinite(car.hp) && car.hp > 0) specifications.push(`${car.hp} hp`);
  if (typeof car.weightLb === "number" && Number.isFinite(car.weightLb) && car.weightLb > 0) {
    specifications.push(unit === "metric" ? `${Math.round(car.weightLb * 0.453592)} kg` : `${Math.round(car.weightLb).toLocaleString()} lb`);
  }
  return (
    <article className="group self-start overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 transition-colors hover:border-app-border-hover/30">
      {hasImage && <div className="relative h-40 overflow-hidden bg-gradient-to-br from-app-text/10 via-app-surface-alt/20 to-app-bg/20">
        <div className="absolute inset-0 flex items-center justify-center text-3xl font-black italic text-app-text/10">{gameId === "ams2" ? "AMS2" : "iR"}</div>
        {hasImage && (
          <img
            src={car.imageUrl}
            alt={car.name}
            loading="lazy"
            className={`relative h-full w-full object-center transition-transform duration-300 group-hover:scale-[1.02] ${gameId === "ams2" ? "object-contain" : "object-cover"}`}
            onError={() => setImageFailed(true)}
          />
        )}
        <span
          className="catalog-category-badge absolute bottom-2 right-2 rounded border px-2 py-0.5 text-app-caption font-bold shadow-sm backdrop-blur-sm"
          data-catalog-category={car.category}
        >
          {categoryLabel(m, car.category)}
        </span>
      </div>}
      <div className="p-3 space-y-2">
        {!hasImage && <div className="flex items-center justify-between gap-2">
          <span className="text-app-caption font-bold text-app-text-muted">{gameId === "ams2" ? "AMS2" : "iR"}</span>
          <span className="catalog-category-badge rounded border px-2 py-0.5 text-app-caption font-bold" data-catalog-category={car.category}>{categoryLabel(m, car.category)}</span>
        </div>}
        <h2 className="text-sm font-semibold leading-tight text-app-text">{car.name}</h2>
        {specifications.length > 0 && (
          <div className="text-app-caption text-app-text-muted tabular-nums">{specifications.join(" · ")}</div>
        )}
        {(car.rainEnabled || car.hasHeadlights || car.hasMultipleDryTireTypes) && (
          <div className="flex flex-wrap gap-1">
            {car.rainEnabled && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.iracingcars_rain_ready()}</span>}
            {car.hasHeadlights && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.iracingcars_headlights()}</span>}
            {car.hasMultipleDryTireTypes && <span className="rounded border border-app-border bg-app-surface-alt px-1.5 py-0.5 text-app-caption text-app-text-muted">{m.iracingcars_multiple_dry_tires()}</span>}
          </div>
        )}
      </div>
    </article>
  );
}
