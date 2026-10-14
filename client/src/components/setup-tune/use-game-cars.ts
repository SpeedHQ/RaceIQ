import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

export interface GameCarOption {
  id: string;
  name: string;
  class?: string;
}

/** ACC and AC Evo selectors use each game's native catalog identity. */
export function useAccCars() {
  return useQuery<GameCarOption[]>({
    queryKey: ["acc-cars-options"],
    queryFn: async () => {
      const res = await client.api.acc.cars.$get();
      const rows = (await res.json()) as { id: number; name: string; class?: string }[];
      return rows.map((r) => ({ id: String(r.id), name: r.name, class: r.class }));
    },
    staleTime: Infinity,
  });
}

export function useAcEvoCars() {
  return useQuery<GameCarOption[]>({
    queryKey: ["ac-evo-cars-options"],
    queryFn: async () => {
      const res = await client.api["ac-evo"].cars.$get();
      return (await res.json()) as GameCarOption[];
    },
    staleTime: Infinity,
  });
}
