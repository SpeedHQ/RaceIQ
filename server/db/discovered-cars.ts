import { and, eq } from "drizzle-orm";
import { db, readDb } from "./index"
import { discoveredCars } from "./schema";
import { withDatabaseWrite } from "./write-coordination";

import { injectDiscoveredAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { acEvoCarId } from "@raceiq/game-ac-evo-metadata/identity";

export interface DiscoveredCarRow {
  id: number;
  gameId: string;
  carId: string;
  name: string;
  model: string;
  createdAt: string;
}

export async function registerDiscoveredCar(gameId: string, carId: string, name: string): Promise<void> {
  if (gameId === "ac-evo") {
    await registerAcEvoCar(name);
    return;
  }
  await withDatabaseWrite(async () => {
    await db.insert(discoveredCars).values({ gameId, carId, name }).onConflictDoNothing().run();
  });
}

export async function registerAcEvoCar(name: string, model = ""): Promise<string> {
  const id = acEvoCarId(name);
  if (!id) return "";
  await withDatabaseWrite(async () => {
    await db.insert(discoveredCars).values({
      gameId: "ac-evo", carId: id, name: id, model,
    }).onConflictDoNothing().run();
  });
  injectDiscoveredAcEvoCars([{ id, name: id, model }]);
  return id;
}

export async function getDiscoveredCarName(gameId: string, carId: string): Promise<string | undefined> {
  const row = await readDb.select({ name: discoveredCars.name }).from(discoveredCars)
    .where(and(eq(discoveredCars.gameId, gameId), eq(discoveredCars.carId, carId))).get();
  return row?.name;
}

export async function listDiscoveredCars(gameId?: string): Promise<DiscoveredCarRow[]> {
  if (gameId) return readDb.select().from(discoveredCars).where(eq(discoveredCars.gameId, gameId)).all();
  return readDb.select().from(discoveredCars).all();
}
export async function hydrateDiscoveredAcEvoCars(): Promise<void> {
  injectDiscoveredAcEvoCars((await listDiscoveredCars("ac-evo")).map((row) => ({
    id: row.carId, name: row.name, model: row.model,
  })));
}
