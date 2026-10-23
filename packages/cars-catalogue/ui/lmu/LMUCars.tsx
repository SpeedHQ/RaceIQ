import { useCarsCatalogueHost } from "../host";
import type { LMUCatalogueCar } from "../../contracts/host";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CarTireDialog, CompoundCircle, LMU_DRY_COMPOUNDS } from "../cars/TireCompounds";

function categoryLabel(category: string): string {
  return category
    .split(/[_\s]+/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function LMUCars() {
  const { m, AppInput, Button, loadLMUCars } = useCarsCatalogueHost();
  const [search, setSearch] = useState("");
  const [filterClass, setFilterClass] = useState<string | null>(null);
  const [tireCar, setTireCar] = useState<LMUCatalogueCar | null>(null);
  const { data: cars = [], isLoading } = useQuery<LMUCatalogueCar[]>({
    queryKey: ["cars", "lmu"],
    queryFn: loadLMUCars,
    staleTime: Infinity,
  });

  const classes = useMemo(() => [...new Set(cars.map((car) => car.class).filter((value): value is string => !!value))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))), [cars]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cars
      .filter((car) => (!filterClass || car.class === filterClass) && (!query || car.name.toLowerCase().includes(query) || car.series?.some((series) => series.toLowerCase().includes(query))))
      .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }, [cars, filterClass, search]);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <AppInput type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full @3xl/workspace:w-72" />
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
            <button
              key={car.id}
              type="button"
              onClick={() => setTireCar(car)}
              className="group w-full overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 text-left transition-colors hover:border-app-border-hover/30"
            >
              <div className="relative h-40 overflow-hidden bg-gradient-to-br from-app-text/10 via-app-surface-alt/20 to-app-bg/20">
                <div className="absolute inset-0 flex items-center justify-center text-3xl font-black italic text-app-text/10">LMU</div>
                {car.imageUrl && <img src={car.imageUrl} alt={car.name} loading="lazy" className="relative h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                {car.class && <span className="catalog-category-badge absolute bottom-2 right-2 rounded border px-2 py-0.5 text-app-caption font-bold shadow-sm backdrop-blur-sm" data-catalog-category={car.class}>{categoryLabel(car.class)}</span>}
              </div>
              <div className="p-3">
                <h2 className="text-sm font-semibold leading-tight text-app-text">{car.name}</h2>
                {car.series && car.series.length > 0 && <p className="mt-1 text-xs text-app-text-muted">{car.series.join(" · ")}</p>}
                {LMU_DRY_COMPOUNDS[car.class ?? ""] ? (
                  <div className="mt-2 flex items-center gap-1" aria-label={`${car.class} dry compounds and wet tires available`}>
                    {LMU_DRY_COMPOUNDS[car.class ?? ""].map((compound) => <CompoundCircle key={compound} compound={compound} />)}
                    <CompoundCircle compound="wet" />
                  </div>
                ) : (
                  <>
                    <div className="mt-2 flex items-center gap-1" aria-label="Dry compounds unknown; wet tires available">
                      <CompoundCircle compound="wet" />
                    </div>
                    <p className="text-xs text-app-text-muted">Class-level dry compounds unknown</p>
                  </>
                )}
                <p className="mt-2 text-xs text-app-text-muted">Track options vary.</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {tireCar && (
        <CarTireDialog
          gameId="lmu"
          carName={tireCar.name}
          carClass={tireCar.class ?? "Unknown class"}
          open
          onOpenChange={(open) => { if (!open) setTireCar(null); }}
        />
      )}
    </div>
  );
}
