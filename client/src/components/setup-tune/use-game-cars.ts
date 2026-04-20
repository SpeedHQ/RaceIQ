import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

export interface GameCarOption {
  ordinal: number;
  name: string;
  class?: string;
}

/** ACC and AC-EVO expose cars as `{ id, model, name, class }` from their
 *  server endpoints. The tune form / list components want a uniform
 *  `{ ordinal, name, class? }` shape, so this hook normalizes. */
export function useAccCars() {
  return useQuery<GameCarOption[]>({
    queryKey: ["acc-cars-options"],
    queryFn: async () => {
      const res = await client.api.acc.cars.$get();
      const rows = (await res.json()) as { id: number; name: string; class?: string }[];
      return rows.map((r) => ({ ordinal: r.id, name: r.name, class: r.class }));
    },
    staleTime: Infinity,
  });
}

export function useAcEvoCars() {
  return useQuery<GameCarOption[]>({
    queryKey: ["ac-evo-cars-options"],
    queryFn: async () => {
      const res = await client.api["ac-evo"].cars.$get();
      const rows = (await res.json()) as { id: number; name: string; class?: string }[];
      return rows.map((r) => ({ ordinal: r.id, name: r.name, class: r.class }));
    },
    staleTime: Infinity,
  });
}
