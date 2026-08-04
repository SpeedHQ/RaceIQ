import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PiBadge } from "@/components/forza/PiBadge";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { loadCarModelConfigs } from "@/data/car-models";
import { useUnits } from "@/hooks/useUnits";
import { client } from "@/lib/rpc";
import { errorFromResponse } from "@/lib/rpc-error";
import { m } from "@/paraglide/messages";
import { useRequiredGameId } from "@/stores/game";
import { CarDetail } from "./CarDetail";
import { CarsGrid } from "./CarsGrid";
import { CarsTable } from "./CarsTable";
import { CompareModal } from "./CompareModal";
import { DRIVETRAINS, filterAndSortCars, formatBrake, formatSpeed, formatWeight, PI_CLASSES } from "./helpers";
import type { Car, SortKey } from "./types";

export function CarsPage() {
  const navigate = useNavigate();
  const gameId = useRequiredGameId();
  const searchParams = useSearch({ strict: false }) as { compare?: string };
  const [configsReady, setConfigsReady] = useState(false);
  useEffect(() => {
    loadCarModelConfigs().then(() => setConfigsReady(true));
  }, []);

  const units = useUnits();
  const isMetric = units.unit === "metric";
  const formatters = useMemo(
    () => ({
      fmtSpeed: (mph: number) => formatSpeed(mph, units.speedLabel, units.fromMph),
      fmtBrake: (ft: number) => formatBrake(ft, isMetric),
      fmtWeight: (kg: number, lbs: number) => formatWeight(kg, lbs, isMetric),
    }),
    [isMetric, units.fromMph, units.speedLabel],
  );
  const { data: cars = [], isLoading } = useQuery<Car[]>({
    queryKey: ["cars", gameId],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": gameId } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<Car[]>;
    },
    staleTime: 60_000,
  });

  const compareParam = searchParams.compare;
  const initialCompareIds = useMemo(() => {
    if (!compareParam) return null;
    return new Set(
      compareParam
        .split(",")
        .map(Number)
        .filter((number) => !Number.isNaN(number)),
    );
  }, [compareParam]);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [driveFilter, setDriveFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(() => initialCompareIds ?? new Set());
  const [comparing, setComparing] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "grid">("grid");
  const [detailCar, setDetailCar] = useState<Car | null>(null);

  useEffect(() => {
    if (initialCompareIds && initialCompareIds.size >= 2 && cars.length > 0) {
      setSelected(initialCompareIds);
      setComparing(true);
    }
  }, [initialCompareIds, cars.length]);

  const filtered = useMemo(() => filterAndSortCars(cars, search, classFilter, driveFilter, sort, sortDir), [cars, search, classFilter, driveFilter, sort, sortDir]);
  const carMap = useMemo(() => new Map(cars.map((car) => [car.ordinal, car])), [cars]);
  const selectedCars = useMemo(() => [...selected].map((id) => carMap.get(id)).filter((car): car is Car => !!car), [selected, carMap]);

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir((direction) => (direction === 1 ? -1 : 1));
    else {
      setSort(key);
      setSortDir(key === "name" ? 1 : -1);
    }
  }
  function toggleSelect(ordinal: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  }
  function toggleExpanded(ordinal: number) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center flex-wrap gap-2">
        <div className="flex items-center rounded-lg border border-app-border overflow-hidden">
          <Button
            variant="app-ghost"
            size="icon-sm"
            onClick={() => setViewMode("table")}
            title={m.label_table_view()}
            className={`!h-auto !w-auto !rounded-none !p-2.5 transition-colors ${viewMode === "table" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18" />
            </svg>
          </Button>
          <Button
            variant="app-ghost"
            size="icon-sm"
            onClick={() => setViewMode("grid")}
            title={m.label_grid_view()}
            className={`!h-auto !w-auto !rounded-none !p-2.5 transition-colors ${viewMode === "grid" ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text"}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </Button>
        </div>
        <AppInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={m.cars_search_placeholder()}
          className="min-w-[180px] flex-1 @3xl/workspace:w-52 @3xl/workspace:flex-none"
        />
        <div className="flex items-center flex-wrap gap-1">
          {PI_CLASSES.map((cls) => (
            <Button
              key={cls}
              variant="app-ghost"
              size="app-sm"
              onClick={() => setClassFilter(classFilter === cls ? null : cls)}
              className={`!px-3 !py-1.5 text-xs font-bold ${classFilter === cls ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text border border-app-border"}`}
            >
              {cls}
            </Button>
          ))}
        </div>
        <div className="flex items-center flex-wrap gap-1">
          {DRIVETRAINS.map((drive) => (
            <Button
              key={drive}
              variant="app-ghost"
              size="app-sm"
              onClick={() => setDriveFilter(driveFilter === drive ? null : drive)}
              className={`!px-3 !py-1.5 text-xs font-semibold ${driveFilter === drive ? "bg-app-accent/20 text-app-accent" : "bg-app-surface text-app-text/90 hover:text-app-text border border-app-border"}`}
            >
              {drive}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90 text-sm">{m.cars_loading()}</div>
      ) : viewMode === "grid" ? (
        <CarsGrid
          cars={filtered}
          selected={selected}
          configsReady={configsReady}
          onSelect={toggleSelect}
          onDetail={setDetailCar}
          onModel={(ordinal) => navigate({ to: "/fm23/cars/$carOrdinal", params: { carOrdinal: String(ordinal) } })}
          {...formatters}
        />
      ) : (
        <CarsTable
          cars={filtered}
          selected={selected}
          expanded={expanded}
          sort={sort}
          sortDir={sortDir}
          isMetric={isMetric}
          speedLabel={units.speedLabel}
          onSort={toggleSort}
          onSelect={toggleSelect}
          onExpand={toggleExpanded}
          {...formatters}
        />
      )}

      <Dialog open={!!detailCar} onOpenChange={(open) => !open && setDetailCar(null)}>
        {detailCar && (
          <DialogContent size="lg" showCloseButton={false} className="max-w-2xl overflow-hidden p-0">
            <DialogHeader className="flex flex-row items-center justify-between border-b border-app-border px-4 py-3">
              <DialogTitle className="flex items-center gap-2 text-sm font-bold text-app-text/90">
                {detailCar.specs?.pi && <PiBadge showNumber={false} pi={detailCar.specs.pi} />}
                {detailCar.name}
              </DialogTitle>
              <Button variant="close-action" size="icon-sm" onClick={() => setDetailCar(null)} aria-label={m.common_close()}>
                ×
              </Button>
            </DialogHeader>
            <CarDetail car={detailCar} isMetric={isMetric} {...formatters} />
          </DialogContent>
        )}
      </Dialog>

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-app-surface border border-app-border rounded-full px-4 py-2 shadow-xl">
          <span className="text-xs text-app-text/90">
            {selected.size} {m.cars_selected()}
          </span>
          <Button
            variant="app-outline"
            size="app-sm"
            onClick={() => setComparing(true)}
            disabled={selected.size < 2}
            className="!rounded-full !border-app-accent/30 !px-3 !py-1 text-xs font-semibold text-app-accent bg-app-accent/20 hover:bg-app-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m.cars_compare_button()} ({selected.size})
          </Button>
          <Button variant="app-ghost" size="app-sm" onClick={() => setSelected(new Set())}>
            {m.common_clear()}
          </Button>
        </div>
      )}
      {comparing && selectedCars.length >= 2 && <CompareModal cars={selectedCars} onClose={() => setComparing(false)} isMetric={isMetric} {...formatters} />}
    </div>
  );
}
