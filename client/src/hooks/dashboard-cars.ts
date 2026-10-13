import type { GameId } from "@raceiq/shared/games/ids";
import { useQuery } from "@tanstack/react-query";
import { teams } from "@/components/f1/cars/data";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";

interface DashboardCar {
  id?: string | null;
  class?: string;
  imageUrl?: string | null;
  specs?: { imageUrl?: string | null; pi?: number } | null;
}

export function useDashboardCars(gameId: GameId | null | undefined, enabled: boolean) {
  return useQuery<DashboardCar[]>({
    queryKey: ["dashboard-cars", gameId],
    queryFn: async () => {
      if (!gameId || gameId === "ac-evo") return [];
      if (gameId === "acc") {
        const cars = await rpcJson<{ id: number; class: string }[]>(await client.api.acc.cars.$get());
        return cars.map((car) => ({ id: String(car.id), class: car.class, imageUrl: `/car-images/acc-${car.id}.jpg` }));
      }
      const cars = await rpcJson<DashboardCar[]>(await client.api.cars.$get({}, { headers: { "X-Game-Id": gameId } }));
      if (gameId === "f1-2025") {
        return cars.map((car) => ({
          ...car,
          imageUrl: teams.find((team) => String(team.id) === car.id)?.image
            ?? teams.find((team) => team.id === 8)?.image,
        }));
      }
      return cars;
    },
    enabled: !!gameId && enabled,
    staleTime: Infinity,
  });
}
