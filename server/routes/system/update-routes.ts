import { Hono } from "hono";

import { getUpdateState, checkForUpdate, applyUpdate } from "../../update-check";

export const updateRoutes = new Hono()
  // GET /api/version — current version + update availability
  .get("/api/version", (c) => {
    return c.json(getUpdateState());
  })

  // POST /api/update/check — force a fresh update check and return result
  .post("/api/update/check", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })

  // POST /api/update/apply — download and apply the pending update, then restart
  .post("/api/update/apply", async (c) => {
    try {
      await applyUpdate(); // starts download, spawns swap script, then process exits
      return new Response(null, { status: 204 });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });
