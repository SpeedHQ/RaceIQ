import { Hono } from "hono";
import {
  insertTune,
  getTunes,
  getTuneById,
  updateTune,
  deleteTune,
  setTuneAssignment,
  getTuneAssignment,
  getTuneAssignments,
  deleteTuneAssignment,
  updateLapTune,
} from "../db/tune-queries";

// Static catalog data — loaded from shared JSON via the client catalog module pattern
// We import the raw JSON files directly on the server side
import balancedCircuit from "../../shared/tunes/2860-amv-gt3-balanced-circuit.json";
import aggressiveCircuit from "../../shared/tunes/2860-amv-gt3-aggressive-circuit.json";
import wetWeather from "../../shared/tunes/2860-amv-gt3-wet-weather.json";
import topSpeed from "../../shared/tunes/2860-amv-gt3-top-speed.json";
import stableBeginner from "../../shared/tunes/2860-amv-gt3-stable-beginner.json";
import nordschleife from "../../shared/tunes/2860-amv-gt3-nordschleife.json";
import spa from "../../shared/tunes/2860-amv-gt3-spa.json";

interface CatalogTune {
  id: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: any[];
  settings: any;
}

const TUNE_CATALOG: CatalogTune[] = [
  balancedCircuit,
  aggressiveCircuit,
  wetWeather,
  topSpeed,
  stableBeginner,
  nordschleife,
  spa,
] as CatalogTune[];

function getCatalogTuneById(id: string): CatalogTune | undefined {
  return TUNE_CATALOG.find((t) => t.id === id);
}

function validateTuneSettings(settings: any): boolean {
  if (!settings || typeof settings !== "object") return false;
  const required = [
    "tires",
    "gearing",
    "alignment",
    "antiRollBars",
    "springs",
    "damping",
    "aero",
    "differential",
    "brakes",
  ];
  for (const key of required) {
    if (!settings[key] || typeof settings[key] !== "object") return false;
  }
  if (
    typeof settings.tires.frontPressure !== "number" ||
    typeof settings.tires.rearPressure !== "number"
  )
    return false;
  if (typeof settings.gearing.finalDrive !== "number") return false;
  if (
    typeof settings.brakes.balance !== "number" ||
    typeof settings.brakes.pressure !== "number"
  )
    return false;
  return true;
}

/** Parse JSON text columns from a DB tune row into proper arrays/objects */
function parseTuneRow(row: any) {
  return {
    ...row,
    strengths: row.strengths ? JSON.parse(row.strengths) : [],
    weaknesses: row.weaknesses ? JSON.parse(row.weaknesses) : [],
    bestTracks: row.bestTracks ? JSON.parse(row.bestTracks) : [],
    strategies: row.strategies ? JSON.parse(row.strategies) : [],
    settings: row.settings ? JSON.parse(row.settings) : null,
  };
}

export const tuneRoutes = new Hono();

// ─── Tune CRUD ───────────────────────────────────────────────────────────────

// GET /api/tunes — list user tunes, optional ?carOrdinal= filter
tuneRoutes.get("/api/tunes", (c) => {
  const carOrdinalParam = c.req.query("carOrdinal");
  const carOrdinal = carOrdinalParam ? parseInt(carOrdinalParam, 10) : undefined;
  if (carOrdinalParam && isNaN(carOrdinal!)) {
    return c.json({ error: "Invalid carOrdinal" }, 400);
  }
  const rows = getTunes(carOrdinal);
  return c.json(rows.map(parseTuneRow));
});

// GET /api/tunes/:id — get single tune
tuneRoutes.get("/api/tunes/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);
  const row = getTuneById(id);
  if (!row) return c.json({ error: "Tune not found" }, 404);
  return c.json(parseTuneRow(row));
});

// POST /api/tunes — create tune
tuneRoutes.post("/api/tunes", async (c) => {
  const body = await c.req.json();
  const { name, author, carOrdinal, category, settings } = body;

  if (!name || !author || carOrdinal == null || !category || !settings) {
    return c.json(
      { error: "Missing required fields: name, author, carOrdinal, category, settings" },
      400
    );
  }

  if (!validateTuneSettings(settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }

  const id = insertTune({
    name,
    author,
    carOrdinal,
    category,
    trackOrdinal: body.trackOrdinal,
    description: body.description ?? "",
    strengths: body.strengths ? JSON.stringify(body.strengths) : undefined,
    weaknesses: body.weaknesses ? JSON.stringify(body.weaknesses) : undefined,
    bestTracks: body.bestTracks ? JSON.stringify(body.bestTracks) : undefined,
    strategies: body.strategies ? JSON.stringify(body.strategies) : undefined,
    settings: JSON.stringify(settings),
    source: body.source ?? "user",
    catalogId: body.catalogId,
  });

  const created = getTuneById(id);
  return c.json(parseTuneRow(created), 201);
});

// PUT /api/tunes/:id — update tune
tuneRoutes.put("/api/tunes/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);

  const body = await c.req.json();

  if (body.settings && !validateTuneSettings(body.settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }

  const data: Record<string, any> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.author !== undefined) data.author = body.author;
  if (body.carOrdinal !== undefined) data.carOrdinal = body.carOrdinal;
  if (body.category !== undefined) data.category = body.category;
  if (body.trackOrdinal !== undefined) data.trackOrdinal = body.trackOrdinal;
  if (body.description !== undefined) data.description = body.description;
  if (body.strengths !== undefined) data.strengths = JSON.stringify(body.strengths);
  if (body.weaknesses !== undefined) data.weaknesses = JSON.stringify(body.weaknesses);
  if (body.bestTracks !== undefined) data.bestTracks = JSON.stringify(body.bestTracks);
  if (body.strategies !== undefined) data.strategies = JSON.stringify(body.strategies);
  if (body.settings !== undefined) data.settings = JSON.stringify(body.settings);

  const updated = updateTune(id, data);
  if (!updated) return c.json({ error: "Tune not found" }, 404);

  const row = getTuneById(id);
  return c.json(parseTuneRow(row));
});

// DELETE /api/tunes/:id — delete tune
tuneRoutes.delete("/api/tunes/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid tune ID" }, 400);
  const deleted = deleteTune(id);
  if (!deleted) return c.json({ error: "Tune not found" }, 404);
  return c.json({ success: true });
});

// POST /api/tunes/import — same as POST /api/tunes (accepts full tune JSON)
tuneRoutes.post("/api/tunes/import", async (c) => {
  const body = await c.req.json();
  const { name, author, carOrdinal, category, settings } = body;

  if (!name || !author || carOrdinal == null || !category || !settings) {
    return c.json(
      { error: "Missing required fields: name, author, carOrdinal, category, settings" },
      400
    );
  }

  if (!validateTuneSettings(settings)) {
    return c.json({ error: "Invalid settings structure" }, 400);
  }

  const id = insertTune({
    name,
    author,
    carOrdinal,
    category,
    trackOrdinal: body.trackOrdinal,
    description: body.description ?? "",
    strengths: body.strengths ? JSON.stringify(body.strengths) : undefined,
    weaknesses: body.weaknesses ? JSON.stringify(body.weaknesses) : undefined,
    bestTracks: body.bestTracks ? JSON.stringify(body.bestTracks) : undefined,
    strategies: body.strategies ? JSON.stringify(body.strategies) : undefined,
    settings: JSON.stringify(settings),
    source: body.source ?? "user",
    catalogId: body.catalogId,
  });

  const created = getTuneById(id);
  return c.json(parseTuneRow(created), 201);
});

// POST /api/tunes/clone/:catalogId — clone a catalog tune into DB
tuneRoutes.post("/api/tunes/clone/:catalogId", (c) => {
  const catalogId = c.req.param("catalogId");
  const catalogTune = getCatalogTuneById(catalogId);
  if (!catalogTune) return c.json({ error: "Catalog tune not found" }, 404);

  const id = insertTune({
    name: `${catalogTune.name} (copy)`,
    author: catalogTune.author,
    carOrdinal: catalogTune.carOrdinal,
    category: catalogTune.category,
    trackOrdinal: catalogTune.trackOrdinal,
    description: catalogTune.description,
    strengths: JSON.stringify(catalogTune.strengths ?? []),
    weaknesses: JSON.stringify(catalogTune.weaknesses ?? []),
    bestTracks: JSON.stringify(catalogTune.bestTracks ?? []),
    strategies: JSON.stringify(catalogTune.strategies ?? []),
    settings: JSON.stringify(catalogTune.settings),
    source: "catalog-clone",
    catalogId: catalogTune.id,
  });

  const created = getTuneById(id);
  return c.json(parseTuneRow(created), 201);
});

// ─── Catalog ─────────────────────────────────────────────────────────────────

// GET /api/catalog/tunes — return static TUNE_CATALOG
tuneRoutes.get("/api/catalog/tunes", (c) => {
  const carOrdinalParam = c.req.query("carOrdinal");
  if (carOrdinalParam) {
    const carOrdinal = parseInt(carOrdinalParam, 10);
    if (isNaN(carOrdinal)) return c.json({ error: "Invalid carOrdinal" }, 400);
    return c.json(TUNE_CATALOG.filter((t) => t.carOrdinal === carOrdinal));
  }
  return c.json(TUNE_CATALOG);
});

// ─── Assignments ─────────────────────────────────────────────────────────────

// GET /api/tune-assignments — list all, optional ?carOrdinal= filter
tuneRoutes.get("/api/tune-assignments", (c) => {
  const carOrdinalParam = c.req.query("carOrdinal");
  const carOrdinal = carOrdinalParam ? parseInt(carOrdinalParam, 10) : undefined;
  if (carOrdinalParam && isNaN(carOrdinal!)) {
    return c.json({ error: "Invalid carOrdinal" }, 400);
  }
  return c.json(getTuneAssignments(carOrdinal));
});

// GET /api/tune-assignments/:carOrdinal/:trackOrdinal — get specific assignment
tuneRoutes.get("/api/tune-assignments/:carOrdinal/:trackOrdinal", (c) => {
  const carOrdinal = parseInt(c.req.param("carOrdinal"), 10);
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(carOrdinal) || isNaN(trackOrdinal)) {
    return c.json({ error: "Invalid carOrdinal or trackOrdinal" }, 400);
  }
  const assignment = getTuneAssignment(carOrdinal, trackOrdinal);
  if (!assignment) return c.json({ error: "Assignment not found" }, 404);
  return c.json(assignment);
});

// PUT /api/tune-assignments — set/update assignment
tuneRoutes.put("/api/tune-assignments", async (c) => {
  const body = await c.req.json();
  const { carOrdinal, trackOrdinal, tuneId } = body;
  if (carOrdinal == null || trackOrdinal == null || tuneId == null) {
    return c.json({ error: "Missing required fields: carOrdinal, trackOrdinal, tuneId" }, 400);
  }
  setTuneAssignment(carOrdinal, trackOrdinal, tuneId);
  const assignment = getTuneAssignment(carOrdinal, trackOrdinal);
  return c.json(assignment);
});

// DELETE /api/tune-assignments/:carOrdinal/:trackOrdinal — remove assignment
tuneRoutes.delete("/api/tune-assignments/:carOrdinal/:trackOrdinal", (c) => {
  const carOrdinal = parseInt(c.req.param("carOrdinal"), 10);
  const trackOrdinal = parseInt(c.req.param("trackOrdinal"), 10);
  if (isNaN(carOrdinal) || isNaN(trackOrdinal)) {
    return c.json({ error: "Invalid carOrdinal or trackOrdinal" }, 400);
  }
  const deleted = deleteTuneAssignment(carOrdinal, trackOrdinal);
  if (!deleted) return c.json({ error: "Assignment not found" }, 404);
  return c.json({ success: true });
});

// ─── Lap tune override ──────────────────────────────────────────────────────

// PATCH /api/laps/:id/tune — set or clear tune for specific lap
tuneRoutes.patch("/api/laps/:id/tune", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid lap ID" }, 400);
  const body = await c.req.json();
  const { tuneId } = body;
  if (tuneId === undefined) {
    return c.json({ error: "Missing tuneId field (number or null)" }, 400);
  }
  if (tuneId !== null && typeof tuneId !== "number") {
    return c.json({ error: "tuneId must be a number or null" }, 400);
  }
  const updated = updateLapTune(id, tuneId);
  if (!updated) return c.json({ error: "Lap not found" }, 404);
  return c.json({ success: true });
});
