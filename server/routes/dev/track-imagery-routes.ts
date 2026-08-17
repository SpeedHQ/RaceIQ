import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { z } from "zod";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { TrackVenueIdSchema, trackConfigurationVenueId } from "../../../shared/racing/tracks/configuration";
import {
  TrackImageryCalibrationSchema,
  TrackImageryGeographicBoundsSchema,
  TrackImageryGeographicReferenceSchema,
  TrackImageryLayoutManifestSchema,
  TrackImageryVenueManifestSchema,
  type TrackImageryGeographicBounds,
  type TrackImageryLayoutManifest,
  type TrackImageryVenueManifest,
} from "../../../shared/racing/tracks/imagery";
import { loadTrackConfiguration } from "../../tracks/configuration";
import { loadOpenTrackImageryRaster, searchOpenTrackImagery } from "../../tracks/imagery-sources";
import { resolveTrackGeographicCatalogSource, trackGeographicReferencePositions } from "../../tracks/geographic-reference";
import { listTrackImageryConfigurations, loadTrackImageryLayout, loadTrackImageryVenue, trackImageryContentType, trackImageryLayoutPath, trackImageryVenueDirectory } from "../../tracks/imagery";
import { resolveTrackOutline } from "../tracks/support";

const MAX_TRACK_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_TRACK_IMAGE_PIXELS = 200_000_000;
const SUPPORTED_FORMATS: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const openImageryBaseRequestSchema = z.object({
  candidateId: z.string().trim().min(1),
  bounds: TrackImageryGeographicBoundsSchema,
  calibration: TrackImageryCalibrationSchema,
});

interface ValidatedImage {
  bytes: Uint8Array;
  extension: string;
}

function gameAndTrack(c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }): { gameId: GameId; trackOrdinal: number } {
  const gameId = GameIdSchema.parse(c.req.query("gameId"));
  const trackOrdinal = Number.parseInt(c.req.param("ordinal"), 10);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return { gameId, trackOrdinal };
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  return value;
}
function venueIdFromQuery(c: { req: { query: (key: string) => string | undefined } }): string {
  return TrackVenueIdSchema.parse(c.req.query("venueId"));
}
function imageryBoundsFromQuery(c: { req: { query: (key: string) => string | undefined } }): TrackImageryGeographicBounds {
  return TrackImageryGeographicBoundsSchema.parse({
    west: Number(c.req.query("west")),
    south: Number(c.req.query("south")),
    east: Number(c.req.query("east")),
    north: Number(c.req.query("north")),
  });
}

async function validatedImage(file: File, requireAlpha: boolean): Promise<ValidatedImage> {
  if (file.size <= 0 || file.size > MAX_TRACK_IMAGE_BYTES) throw new Error("Track image must be between 1 byte and 100 MiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await sharp(bytes, { limitInputPixels: MAX_TRACK_IMAGE_PIXELS }).metadata();
  const extension = metadata.format ? SUPPORTED_FORMATS[metadata.format] : undefined;
  if (!extension || !metadata.width || !metadata.height) throw new Error("Track image must be PNG, JPEG, or WebP");
  if (requireAlpha && !metadata.hasAlpha) throw new Error("Overlay layer must contain an alpha channel");
  return { bytes, extension };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function replaceTexture(directory: string, stem: string, image: ValidatedImage): string {
  mkdirSync(directory, { recursive: true });
  const fileName = `${stem}.${image.extension}`;
  const target = resolve(directory, fileName);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, image.bytes);
  renameSync(temporary, target);
  for (const entry of readdirSync(directory)) {
    if (entry !== fileName && entry.startsWith(`${stem}.`) && /\.(?:png|jpe?g|webp)$/i.test(entry)) unlinkSync(resolve(directory, entry));
  }
  return fileName;
}

function removeLayerFromLayouts(venueId: string, layerId: string): void {
  for (const layout of listTrackImageryConfigurations().layouts) {
    const configuration = loadTrackConfiguration(layout.gameId, layout.trackOrdinal);
    if (!configuration || trackConfigurationVenueId(configuration) !== venueId || !layout.layers.includes(layerId)) continue;
    writeJson(trackImageryLayoutPath(layout.gameId, layout.trackOrdinal), {
      ...layout,
      layers: layout.layers.filter((id) => id !== layerId),
    });
  }
}

export const trackImageryDevRoutes = new Hono()
  .get("/api/dev/track-imagery", (c) => c.json(listTrackImageryConfigurations()))
  .get("/api/dev/track-imagery/reference/:ordinal", async (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const source = resolveTrackGeographicCatalogSource(gameId, trackOrdinal);
      if (!source) return c.json(null);
      let outline = await resolveTrackOutline(trackOrdinal, gameId);
      if (!outline && (gameId !== "iracing" || trackOrdinal !== source.track.ordinal)) {
        outline = await resolveTrackOutline(source.track.ordinal, "iracing");
      }
      const center = { latitudeDeg: source.track.latitude, longitudeDeg: source.track.longitude };
      return c.json(
        TrackImageryGeographicReferenceSchema.parse({
          sourceGameId: "iracing",
          sourceTrackOrdinal: source.track.ordinal,
          sourceName: source.track.variant ? `${source.track.name} — ${source.track.variant}` : source.track.name,
          match: source.match,
          outlineSource: outline?.source ?? "estimated",
          center,
          geographicPositions: trackGeographicReferencePositions(outline?.points ?? null, center, source.track.lengthKm),
        }),
      );
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to resolve track geographic reference" }, 400);
    }
  })
  .post("/api/dev/track-imagery/sources/search", async (c) => {
    try {
      const raw = (await c.req.json()) as { bounds?: unknown };
      return c.json(await searchOpenTrackImagery(raw.bounds));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to search open imagery" }, 400);
    }
  })
  .get("/api/dev/track-imagery/sources/preview", async (c) => {
    try {
      const candidateId = c.req.query("candidateId");
      if (!candidateId) return c.json({ error: "Missing imagery source" }, 400);
      const raster = await loadOpenTrackImageryRaster(candidateId, imageryBoundsFromQuery(c), "preview");
      return new Response(Uint8Array.from(raster.bytes).buffer, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "image/webp",
          "X-Imagery-Height": String(raster.height),
          "X-Imagery-Width": String(raster.width),
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to preview open imagery" }, 400);
    }
  })
  .post("/api/dev/track-imagery/venues/base/source", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const requestBody = openImageryBaseRequestSchema.parse(await c.req.json());
      const raster = await loadOpenTrackImageryRaster(requestBody.candidateId, requestBody.bounds, "asset");
      const current = loadTrackImageryVenue(venueId);
      const manifest = TrackImageryVenueManifestSchema.parse({
        version: 1,
        venueId,
        calibration: requestBody.calibration,
        base: { image: "base.webp", source: raster.source },
        layers: current?.layers ?? [],
      });
      const directory = trackImageryVenueDirectory(venueId);
      replaceTexture(directory, "base", { bytes: raster.bytes, extension: "webp" });
      writeJson(resolve(directory, "manifest.json"), manifest);
      return c.json(manifest, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to import open imagery" }, 400);
    }
  })
  .get("/api/dev/track-imagery/venues/manifest", (c) => {
    try {
      return c.json(loadTrackImageryVenue(venueIdFromQuery(c)));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to load imagery venue" }, 400);
    }
  })
  .get("/api/dev/track-imagery/venues/texture/:textureId", (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const textureId = c.req.param("textureId") === "base" ? "base" : safeId(c.req.param("textureId"), "Texture ID");
      const venue = loadTrackImageryVenue(venueId);
      if (!venue) return c.json({ error: "Imagery venue not found" }, 404);
      const fileName = textureId === "base" ? venue.base.image : venue.layers.find((layer) => layer.id === textureId)?.image;
      if (!fileName) return c.json({ error: "Imagery texture not found" }, 404);
      const path = textureId === "base" ? resolve(trackImageryVenueDirectory(venueId), fileName) : resolve(trackImageryVenueDirectory(venueId), "layers", fileName);
      if (!existsSync(path)) return c.json({ error: "Imagery texture file not found" }, 404);
      return new Response(Bun.file(path), {
        headers: { "Cache-Control": "no-store", "Content-Type": trackImageryContentType(path) },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to load imagery texture" }, 400);
    }
  })
  .post("/api/dev/track-imagery/venues/base", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "Missing base texture" }, 400);
      const image = await validatedImage(file, false);
      const directory = trackImageryVenueDirectory(venueId);
      const imageName = `base.${image.extension}`;
      const raw = JSON.parse(String(form.get("manifest") ?? "null")) as Record<string, unknown>;
      const manifest = TrackImageryVenueManifestSchema.parse({
        ...raw,
        version: 1,
        venueId,
        base: { ...(raw.base as Record<string, unknown> | undefined), image: imageName },
      });
      replaceTexture(directory, "base", image);
      writeJson(resolve(directory, "manifest.json"), manifest);
      return c.json(manifest, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to save base texture" }, 400);
    }
  })
  .put("/api/dev/track-imagery/venues/manifest", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const current = loadTrackImageryVenue(venueId);
      if (!current) return c.json({ error: "Imagery venue not found" }, 404);
      const raw = (await c.req.json()) as TrackImageryVenueManifest;
      const layersById = new Map(current.layers.map((layer) => [layer.id, layer]));
      const manifest = TrackImageryVenueManifestSchema.parse({
        ...raw,
        version: 1,
        venueId,
        base: { ...raw.base, image: current.base.image },
        layers: raw.layers.map((layer) => ({
          ...layer,
          image: layersById.get(layer.id)?.image ?? layer.image,
        })),
      });
      writeJson(resolve(trackImageryVenueDirectory(venueId), "manifest.json"), manifest);
      return c.json(manifest);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to update imagery venue" }, 400);
    }
  })
  .post("/api/dev/track-imagery/venues/layers/:layerId", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const layerId = safeId(c.req.param("layerId"), "Layer ID");
      const venue = loadTrackImageryVenue(venueId);
      if (!venue) return c.json({ error: "Save venue base before adding layers" }, 404);
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "Missing overlay texture" }, 400);
      const image = await validatedImage(file, true);
      const layersDirectory = resolve(trackImageryVenueDirectory(venueId), "layers");
      const imageName = `${layerId}.${image.extension}`;
      const rawLayer = JSON.parse(String(form.get("layer") ?? "null")) as Record<string, unknown>;
      const layer = { ...rawLayer, id: layerId, image: imageName };
      const manifest = TrackImageryVenueManifestSchema.parse({
        ...venue,
        layers: [...venue.layers.filter((candidate) => candidate.id !== layerId), layer],
      });
      replaceTexture(layersDirectory, layerId, image);
      writeJson(resolve(trackImageryVenueDirectory(venueId), "manifest.json"), manifest);
      return c.json(manifest, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to save imagery layer" }, 400);
    }
  })
  .delete("/api/dev/track-imagery/venues/layers/:layerId", (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const layerId = safeId(c.req.param("layerId"), "Layer ID");
      const venue = loadTrackImageryVenue(venueId);
      if (!venue) return c.json({ error: "Imagery venue not found" }, 404);
      const layer = venue.layers.find((candidate) => candidate.id === layerId);
      if (!layer) return c.json({ error: "Imagery layer not found" }, 404);
      const manifest = { ...venue, layers: venue.layers.filter((candidate) => candidate.id !== layerId) };
      writeJson(resolve(trackImageryVenueDirectory(venueId), "manifest.json"), manifest);
      const imagePath = resolve(trackImageryVenueDirectory(venueId), "layers", layer.image);
      if (existsSync(imagePath)) unlinkSync(imagePath);
      removeLayerFromLayouts(venueId, layerId);
      return c.json(manifest);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to remove imagery layer" }, 400);
    }
  })
  .get("/api/dev/track-imagery/layouts/:ordinal", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      return c.json(loadTrackImageryLayout(gameId, trackOrdinal));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to load imagery layout" }, 400);
    }
  })
  .put("/api/dev/track-imagery/layouts/:ordinal", async (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const configuration = loadTrackConfiguration(gameId, trackOrdinal);
      if (!configuration) return c.json({ error: "Save track venue assignment before imagery layers" }, 404);
      const raw = (await c.req.json()) as TrackImageryLayoutManifest;
      const layout = TrackImageryLayoutManifestSchema.parse({ ...raw, version: 1, gameId, trackOrdinal });
      const venueId = trackConfigurationVenueId(configuration);
      const venue = loadTrackImageryVenue(venueId);
      if (!venue) return c.json({ error: `Imagery venue ${venueId} not found` }, 404);
      const knownLayers = new Set(venue.layers.map((layer) => layer.id));
      const missingLayer = layout.layers.find((layerId) => !knownLayers.has(layerId));
      if (missingLayer) return c.json({ error: `Imagery layer ${missingLayer} not found` }, 400);
      writeJson(trackImageryLayoutPath(gameId, trackOrdinal), layout);
      return c.json(layout);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to save imagery layout" }, 400);
    }
  })
  .delete("/api/dev/track-imagery/layouts/:ordinal", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const path = trackImageryLayoutPath(gameId, trackOrdinal);
      if (existsSync(path)) unlinkSync(path);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to remove imagery layout" }, 400);
    }
  });
