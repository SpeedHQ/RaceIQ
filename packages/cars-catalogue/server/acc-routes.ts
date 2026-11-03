import { Hono } from "hono";
import { getAllAccCars, getAccCarById } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccCarSpecs } from "@raceiq/game-acc-metadata/racing/cars/acc-specs";

export const accCarRoutes = new Hono()
  .get("/api/acc/cars", (c) => {
    const cars = getAllAccCars().map((car) => ({
      ...car,
      specs: getAccCarSpecs(car.id) ?? null,
    }));
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })
  .get("/api/acc/cars/:carId/class", (c) => {
    const carId = c.req.param("carId");
    return c.json({ class: getAccCarById(carId)?.class ?? null });
  });
