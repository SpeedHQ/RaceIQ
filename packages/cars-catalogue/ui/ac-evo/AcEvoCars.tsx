import { useCarsCatalogueHost } from "../host";
import type { AcEvoCatalogueCar } from "../../contracts/host";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CarTireDialog, TireCompoundDots } from "../cars/TireCompounds";

function getManufacturer(name: string): string {
  if (name.startsWith("Alfa Romeo")) return "Alfa Romeo";
  if (name.startsWith("Mercedes-AMG")) return "Mercedes-AMG";
  return name.split(" ")[0];
}

export function AcEvoCars() {
  const { Badge, Button, m, loadAcEvoCars } = useCarsCatalogueHost();
  const { data: cars = [], isLoading } = useQuery<AcEvoCatalogueCar[]>({
    queryKey: ["ac-evo-cars"],
    queryFn: loadAcEvoCars,
  });

  const [filterClass, setFilterClass] = useState<string | null>(null);
  const [tireCar, setTireCar] = useState<AcEvoCatalogueCar | null>(null);

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
    const map = new Map<string, AcEvoCatalogueCar[]>();
    for (const car of filtered) {
      const list = map.get(car.class) ?? [];
      list.push(car);
      map.set(car.class, list);
    }
    return map;
  }, [filtered]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-app-text-dim">{m.acevocars_loading()}</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          <Button variant={filterClass ? "app-ghost" : "selected-toggle"} size="app-sm" aria-pressed={filterClass === null} onClick={() => setFilterClass(null)}>
            {m.acevocars_filter_all()}
          </Button>
          {classes.map((cls) => {
            const count = cars.filter((car) => car.class === cls).length;
            return (
              <Button
                key={cls}
                variant={filterClass === cls ? "selected-toggle" : "app-ghost"}
                size="app-sm"
                data-catalog-category={cls}
                aria-pressed={filterClass === cls}
                onClick={() => setFilterClass(filterClass === cls ? null : cls)}
              >
                {cls} ({count})
              </Button>
            );
          })}
        </div>
      </div>

      {/* Car grid by class */}
      {Array.from(grouped.entries()).map(([cls, classCars]) => {
        return (
          <div key={cls}>
            <div className="flex items-center gap-2 mb-3">
              <Badge variant="catalog-category" size="default" data-catalog-category={cls}>
                {cls}
              </Badge>
              <span className="text-xs text-app-text-dim">{classCars.length} cars</span>
            </div>
            <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3">
              {classCars.map((car) => {
                const brand = getManufacturer(car.name);
                return (
                  <button
                    key={car.id}
                    type="button"
                    data-car-brand={brand}
                    onClick={() => setTireCar(car)}
                    className="group relative w-full overflow-hidden rounded-lg border border-app-border/10 bg-app-surface-alt/20 text-left transition-all hover:border-app-border-hover/30"
                  >
                    <div className="brand-color-strip h-0.5" />
                    <div className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-app-text leading-tight">{car.name}</div>
                          <div className="text-xs text-app-text-muted mt-0.5">{brand}</div>
                        </div>
                        <Badge variant="catalog-category" size="compact" className="shrink-0" data-catalog-category={cls}>
                          {cls}
                        </Badge>
                      </div>
                      <TireCompoundDots gameId="ac-evo" className="mt-2" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {tireCar && (
        <CarTireDialog
          gameId="ac-evo"
          carName={tireCar.name}
          open
          onOpenChange={(open) => { if (!open) setTireCar(null); }}
        />
      )}
    </div>
  );
}
