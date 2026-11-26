import { resolve } from "node:path";
import { getDiscoveredCarName, listDiscoveredCars } from "@raceiq/backend-core/db/discovered-cars";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { createCarRoutes } from "@raceiq/cars-catalogue/server";

export const carRoutes = createCarRoutes({
  getDiscoveredCarName,
  listDiscoveredCars,
  tryGetServerGame,
  carModelConfigsPath: resolve(USER_DATA_DIR, "car-model-configs.json"),
});
