import { Hono } from "hono";
import { getAllAcEvoCars, getAcEvoCarClass } from "../../shared/ac-evo-car-data";
import { PHYSICS, GRAPHICS, STATIC } from "../games/acc/structs";
import { readWString } from "../games/acc/utils";

export const acEvoRoutes = new Hono()

  .get("/api/ac-evo/cars", (c) => {
    const cars = getAllAcEvoCars().map((car) => ({ ...car }));
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })

  .get("/api/ac-evo/cars/:ordinal/class", (c) => {
    const ord = Number(c.req.param("ordinal"));
    if (!Number.isFinite(ord)) return c.json({ class: null });
    return c.json({ class: getAcEvoCarClass(ord) ?? null });
  })

  .get("/api/ac-evo/debug/raw", (c) => {
    // Lazily import acEvoReader to avoid circular deps
    const { acEvoReader } = require("../index") as typeof import("../index");
    const bufs = acEvoReader.getDebugBuffers?.();
    if (!bufs) {
      return c.json({ error: "AC Evo not connected or getDebugBuffers not available" }, 503);
    }
    const { physics, graphics, staticData } = bufs;

    const p: Record<string, number> = {};
    for (const [key, def] of Object.entries(PHYSICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const { offset, type } = def as { offset: number; type: string };
      if (offset + 4 > physics.length) { p[key] = -999; continue; }
      p[key] = type === "f32" ? physics.readFloatLE(offset) : physics.readInt32LE(offset);
    }

    const g: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(GRAPHICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        g[key] = readWString(graphics, d.offset, d.size!);
      } else {
        if (d.offset + 4 > graphics.length) { g[key] = -999; continue; }
        g[key] = d.type === "f32" ? graphics.readFloatLE(d.offset) : graphics.readInt32LE(d.offset);
      }
    }

    const s: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(STATIC)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        s[key] = readWString(staticData, d.offset, d.size!);
      } else {
        if (d.offset + 4 > staticData.length) { s[key] = -999; continue; }
        s[key] = d.type === "f32" ? staticData.readFloatLE(d.offset) : staticData.readInt32LE(d.offset);
      }
    }

    return c.json({ physics: p, graphics: g, static: s });
  });
