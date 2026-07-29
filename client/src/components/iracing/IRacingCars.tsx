import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { client } from "../../lib/rpc";
import { errorFromResponse } from "../../lib/rpc-error";
import { AppInput } from "../ui/AppInput";
import { Table, TBody, TD, TH, THead, TRow } from "../ui/AppTable";

interface IRacingCatalogCar {
  ordinal: number;
  name: string;
  path: string;
}

export function IRacingCars() {
  const [search, setSearch] = useState("");
  const { data: cars = [], isLoading } = useQuery<IRacingCatalogCar[]>({
    queryKey: ["cars", "iracing"],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "iracing" } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json() as Promise<IRacingCatalogCar[]>;
    },
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return cars;
    return cars.filter((car) => car.name.toLowerCase().includes(query) || car.path.toLowerCase().includes(query));
  }, [cars, search]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <AppInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.cars_search_placeholder()} className="w-full sm:w-72" />
        {!isLoading && (
          <span className="text-xs text-app-text/90-muted whitespace-nowrap">
            {filtered.length} / {cars.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-app-text/90-muted text-sm">{m.cars_loading()}</div>
      ) : (
        <Table>
          <THead>
            <TH>{m.cars_col_car()}</TH>
            <TH>{m.iracingcars_folder()}</TH>
            <TH>{m.iracingcars_native_id()}</TH>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center py-12 text-app-text/90-muted text-sm">
                  {m.cars_no_match()}
                </td>
              </tr>
            ) : (
              filtered.map((car) => (
                <TRow key={car.ordinal}>
                  <TD>
                    <span className="text-xs text-app-text/90">{car.name}</span>
                  </TD>
                  <TD>{car.path ? <code className="text-xs text-app-text/90-muted">{car.path}</code> : <span className="text-xs text-app-text/90-muted">-</span>}</TD>
                  <TD className="tabular-nums text-xs text-app-text/90-muted">{car.ordinal}</TD>
                </TRow>
              ))
            )}
          </TBody>
        </Table>
      )}
    </div>
  );
}
