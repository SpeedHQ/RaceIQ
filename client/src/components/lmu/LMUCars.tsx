import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { errorFromResponse } from "../../lib/rpc-error";
import { AppInput } from "../ui/AppInput";

interface LMUCatalogCar {
  ordinal: number;
  name: string;
}

export function LMUCars() {
  const [search, setSearch] = useState("");
  const { data: cars = [], isLoading } = useQuery<LMUCatalogCar[]>({
    queryKey: ["cars", "lmu"],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "lmu" } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<LMUCatalogCar[]>;
    },
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cars.filter((car) => !query || car.name.toLowerCase().includes(query)).toSorted((left, right) => left.name.localeCompare(right.name) || left.ordinal - right.ordinal);
  }, [cars, search]);

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

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90 text-sm">{m.cars_loading()}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-app-text/90 text-sm">{m.cars_no_match()}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3 @7xl/workspace:grid-cols-4">
          {filtered.map((car) => (
            <article key={car.ordinal} className="flex items-center gap-3 rounded-lg border border-app-border/10 bg-app-surface-alt/20 p-3 transition-colors hover:border-app-border-hover/30">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-app-border/20 bg-app-bg/30 text-xs font-black italic text-app-text-muted">LMU</div>
              <h2 className="min-w-0 text-sm font-semibold leading-tight text-app-text">{car.name}</h2>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
