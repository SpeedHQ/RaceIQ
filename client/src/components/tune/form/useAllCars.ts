// Query all cars for tune form.
import { useQuery } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { errorFromResponse } from "@/lib/rpc-error";
import { useRequiredGameId } from "@/stores/game";

export type TuneFormCar = {
  ordinal: number;
  name: string;
  specs?: {
    topSpeedMph: number;
    hp: number;
    torque: number;
    engine: string;
    drivetrain: string;
    weightKg: number;
    displacement: number;
    aspiration: string;
    imageUrl: string;
    division: string;
  };
};

export function useAllCars() {
  const gameId = useRequiredGameId();
  return useQuery<TuneFormCar[]>({
    queryKey: ["all-cars", gameId],
    queryFn: async () => {
      const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": gameId } });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
    staleTime: Infinity,
  });
}
