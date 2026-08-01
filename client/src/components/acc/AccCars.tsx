import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { client } from "../../lib/rpc";
import { m } from "../../paraglide/messages";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

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

function getManufacturer(name: string): string {
  if (name.startsWith("Aston Martin")) return "Aston Martin";
  if (name.startsWith("Mercedes-AMG")) return "Mercedes-AMG";
  if (name.startsWith("Emil Frey")) return "Emil Frey";
  return name.split(" ")[0];
}

function BrandBadge({ brand }: { brand: string }) {
  const abbr =
    brand === "Mercedes-AMG"
      ? "AMG"
      : brand === "Aston Martin"
        ? "AM"
        : brand === "Lamborghini"
          ? "LAM"
          : brand === "Emil Frey"
            ? "EF"
            : brand === "Chevrolet"
              ? "CHV"
              : brand.slice(0, 3).toUpperCase();

  return (
    <div data-car-brand={brand} className="brand-color-badge w-10 h-10 rounded-lg border flex items-center justify-center shrink-0">
      <span className="text-app-micro font-black tracking-tight">{abbr}</span>
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
    return <div className="flex items-center justify-center h-full text-app-text-dim">{m.cars_loading()}</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Filters & Sort */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          <Button variant={filterClass ? "app-ghost" : "selected-toggle"} size="app-sm" onClick={() => setFilterClass(null)}>
            {m.acccars_all_classes()}
          </Button>
          {classes.map((cls) => {
            const count = cars.filter((car) => car.class === cls).length;
            return (
              <Button
                key={cls}
                variant={filterClass === cls ? "selected-toggle" : "app-ghost"}
                size="app-sm"
                data-catalog-category={cls}
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
              <span className="text-xs text-app-text-dim">
                {classCars.length} {m.acccars_car_count_label()}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3">
              {classCars.map((car) => {
                const brand = getManufacturer(car.name);
                const specs = car.specs;
                return (
                  <div
                    key={car.id}
                    data-car-brand={brand}
                    className="group relative bg-app-surface-alt/20 rounded-lg border border-app-border/10 overflow-hidden hover:border-app-border-hover/30 transition-all"
                  >
                    <div className="brand-color-strip h-0.5" />
                    {/* Car image */}
                    <div className="relative w-full h-48 overflow-hidden bg-app-surface-alt/10">
                      <img
                        src={`/car-images/acc-${car.id}.jpg`}
                        alt={car.name}
                        className="w-full h-full object-cover object-center"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-app-bg/60 via-transparent to-transparent" />
                      <Badge variant="catalog-category" size="compact" className="absolute bottom-2 right-2" data-catalog-category={car.class}>
                        {car.class}
                      </Badge>
                    </div>
                    <div className="p-3">
                      <div className="flex items-center gap-3 mb-2">
                        <BrandBadge brand={brand} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-app-text leading-tight">{car.name}</div>
                          <div className="text-app-caption text-app-text-dim mt-0.5">{brand}</div>
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

      {filtered.length === 0 && <div className="text-center text-app-text-dim py-8">{m.acccars_no_match()}</div>}
    </div>
  );
}
