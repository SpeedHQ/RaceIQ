import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

export interface GameCarOption {
  ordinal: number;
  name: string;
  class?: string;
}

/** ACC exposes native IDs; AC EVO exposes stable source-identity ordinals.
 * The tune form and list components use `{ ordinal, name, class? }`. */
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
      return await res.json();
    },
    staleTime: Infinity,
  });
}
