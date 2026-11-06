import { Hono } from "hono";
import { getAllAcEvoCars, getAcEvoCarClass } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";

export const acEvoCarRoutes = new Hono()
  .get("/api/ac-evo/cars", (c) => {
    const cars = getAllAcEvoCars();
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })
  .get("/api/ac-evo/cars/:carId/class", (c) => {
    const carId = c.req.param("carId").trim();
    const car = getAllAcEvoCars().find((candidate) => candidate.id === carId);
    return c.json({ class: car ? getAcEvoCarClass(car.id) ?? null : null });
  });
