import { Hono } from "hono";
import { networkInterfaces } from "os";

export const networkRoutes = new Hono()
  // GET /api/network/info — local LAN IPv4 addresses + server port so clients
  // can build QR codes for phones/tablets on the same network.
  .get("/api/network/info", (c) => {
    const nics = networkInterfaces();
    const lanIps: string[] = [];
    for (const list of Object.values(nics)) {
      if (!list) continue;
      for (const i of list) {
        if (i.family === "IPv4" && !i.internal) lanIps.push(i.address);
      }
    }
    const port = Number(process.env.SERVER_PORT) || 3117;
    return c.json({ lanIps, port });
  });
