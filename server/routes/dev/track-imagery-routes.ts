import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { z } from "zod";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { TrackVenueIdSchema, trackConfigurationVenueId } from "../../../shared/racing/tracks/configuration";
import {
  TRACK_IMAGERY_MANIFEST_VERSION,
  TrackImageryCalibrationSchema,
  TrackImageryGeographicBoundsSchema,
  TrackImageryGeographicReferenceSchema,
  TrackImageryLayoutManifestSchema,
  TrackImageryVenueManifestSchema,
  type TrackImageryGeographicBounds,
  type TrackImageryLayoutManifest,
  type TrackImageryVenueManifest,
} from "../../../shared/racing/tracks/imagery";
import type { TrackImageryLocation } from "../../tracks/imagery-providers/types";
import { TRACK_IMAGERY_PACKAGE_NAME, readTrackImageryPackMetadata, readTrackImageryPackTile, writeTrackImageryPack, type TrackImageryPackMetadata } from "../../tracks/imagery-pack";
import { loadTrackConfiguration } from "../../tracks/configuration";
import { loadOpenTrackImageryAsset, loadOpenTrackImageryRaster, searchOpenTrackImagery } from "../../tracks/imagery-sources";
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
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
});
const trackImageryIdentitySchema = z.object({
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
});

function trackIdentityFromQuery(c: { req: { query: (key: string) => string | undefined } }): { gameId: GameId; trackOrdinal: number } {
  const gameId = GameIdSchema.parse(c.req.query("gameId"));
  const trackOrdinal = Number.parseInt(c.req.query("trackOrdinal") ?? "", 10);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return { gameId, trackOrdinal };
}

function resolveImageryLocation(gameId: GameId, trackOrdinal: number): TrackImageryLocation {
  const source = resolveTrackGeographicCatalogSource(gameId, trackOrdinal);
  if (!source) throw new Error("Unable to resolve geographic venue for selected track");
  return {
    center: { latitudeDeg: source.track.latitude, longitudeDeg: source.track.longitude },
    country: source.track.country.trim(),
    region: source.track.location.trim(),
  };
}

interface ValidatedImage {
  bytes: Uint8Array;
  extension: string;
  width: number;
  height: number;
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
  return { bytes, extension, width: metadata.width, height: metadata.height };
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

function imageryPackPath(venueId: string): string {
  return resolve(trackImageryVenueDirectory(venueId), TRACK_IMAGERY_PACKAGE_NAME);
}

function removeLooseBaseFiles(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (/^base\.(?:png|jpe?g|webp)$/i.test(entry)) unlinkSync(resolve(directory, entry));
  }
}

async function renderImageryPackPreview(path: string): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const metadata = readTrackImageryPackMetadata(path);
  if (metadata.tier !== "hq" || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1)
    throw new Error("Imagery package has invalid HQ dimensions");
  const width = Math.max(1, Math.min(1_000, metadata.width));
  const height = Math.max(1, Math.min(1_000, Math.round((metadata.height / metadata.width) * width)));
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let y = 0; y < metadata.rows; y += 1) {
    for (let x = 0; x < metadata.columns; x += 1) {
      const value = readTrackImageryPackTile(path, x, y, metadata);
      if (!value) continue;
      const tile = value.data;
      const tileWidth = Math.min(metadata.tileSize, metadata.width - x * metadata.tileSize);
      const tileHeight = Math.min(metadata.tileSize, metadata.height - y * metadata.tileSize);
      if (tileWidth <= 0 || tileHeight <= 0) continue;
      const left = Math.round(((x * metadata.tileSize) / metadata.width) * width);
      const right = Math.round(((x * metadata.tileSize + tileWidth) / metadata.width) * width);
      const top = Math.round(((y * metadata.tileSize) / metadata.height) * height);
      const bottom = Math.round(((y * metadata.tileSize + tileHeight) / metadata.height) * height);
      if (right <= left || bottom <= top) continue;
      const resized = await sharp(tile)
        .resize(right - left, bottom - top, { fit: "fill" })
        .toBuffer();
      composites.push({ input: resized, left, top });
    }
  }
  if (composites.length === 0) throw new Error("Imagery package contains no HQ tiles");
  const bytes = new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite(composites)
      .webp({ quality: 90, effort: 4 })
      .toBuffer(),
  );
  return { bytes, width, height };
}

function packageMetadata(
  asset: { width: number; height: number; tileSize: number; columns: number; rows: number; resolutionM?: number },
  bounds: TrackImageryGeographicBounds,
): TrackImageryPackMetadata {
  return {
    schemaVersion: 1,
    tier: "hq",
    width: asset.width,
    height: asset.height,
    tileSize: asset.tileSize,
    columns: asset.columns,
    rows: asset.rows,
    ...(asset.resolutionM === undefined ? {} : { resolutionM: asset.resolutionM }),
    bounds,
  };
}
async function* manualImageryTiles(
  image: ValidatedImage,
  tileSize: number,
  outputWidth: number,
  outputHeight: number,
): AsyncIterable<{ tier: "hq"; x: number; y: number; width: number; height: number; format: "webp"; data: Uint8Array }> {
  for (let y = 0; y < outputHeight; y += tileSize) {
    for (let x = 0; x < outputWidth; x += tileSize) {
      const width = Math.min(tileSize, outputWidth - x);
      const height = Math.min(tileSize, outputHeight - y);
      const data = new Uint8Array(
        await sharp(image.bytes, { limitInputPixels: MAX_TRACK_IMAGE_PIXELS })
          .resize(outputWidth, outputHeight, { fit: "fill" })
          .extract({ left: x, top: y, width, height })
          .webp({ quality: 90, effort: 4 })
          .toBuffer(),
      );
      yield { tier: "hq", x: Math.floor(x / tileSize), y: Math.floor(y / tileSize), width, height, format: "webp", data };
    }
  }
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
      const requestBody = z
        .object({ bounds: TrackImageryGeographicBoundsSchema })
        .merge(trackImageryIdentitySchema)
        .parse(await c.req.json());
      const location = resolveImageryLocation(requestBody.gameId, requestBody.trackOrdinal);
      return c.json(await searchOpenTrackImagery(requestBody.bounds, location));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to search open imagery" }, 400);
    }
  })
  .get("/api/dev/track-imagery/sources/preview", async (c) => {
    try {
      const candidateId = c.req.query("candidateId");
      if (!candidateId) return c.json({ error: "Missing imagery source" }, 400);
      const { gameId, trackOrdinal } = trackIdentityFromQuery(c);
      const bounds = imageryBoundsFromQuery(c);
      const location = resolveImageryLocation(gameId, trackOrdinal);
      const raster = await loadOpenTrackImageryRaster(candidateId, bounds, location, "preview");
      return new Response(Uint8Array.from(raster.bytes).buffer, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "image/webp",
          "X-Imagery-Height": String(raster.height),
          "X-Imagery-Width": String(raster.width),
        },
      });
    } catch (error) {
      console.error("[Track Imagery] Source preview failed:", error);
      return c.json({ error: error instanceof Error ? error.message : "Unable to preview open imagery" }, 400);
    }
  })
  .post("/api/dev/track-imagery/venues/base/source", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const requestBody = openImageryBaseRequestSchema.parse(await c.req.json());
      console.info(`[Track Imagery] Starting ${requestBody.candidateId} import for venue ${venueId}`);
      const location = resolveImageryLocation(requestBody.gameId, requestBody.trackOrdinal);
      const asset = await loadOpenTrackImageryAsset(requestBody.candidateId, requestBody.bounds, location, 512);
      const current = loadTrackImageryVenue(venueId);
      const manifest = TrackImageryVenueManifestSchema.parse({
        version: TRACK_IMAGERY_MANIFEST_VERSION,
        venueId,
        calibration: requestBody.calibration,
        base: {
          pack: TRACK_IMAGERY_PACKAGE_NAME,
          tileSize: asset.tileSize,
          bounds: requestBody.bounds,
          source: asset.source,
        },
        layers: current?.layers ?? [],
      });
      const directory = trackImageryVenueDirectory(venueId);
      await writeTrackImageryPack(imageryPackPath(venueId), packageMetadata(asset, requestBody.bounds), asset.tiles);
      removeLooseBaseFiles(directory);
      writeJson(resolve(directory, "manifest.json"), manifest);
      console.info(`[Track Imagery] Completed ${requestBody.candidateId} import for venue ${venueId}: ${asset.width}x${asset.height}px, ${asset.columns * asset.rows} internal tiles`);
      return c.json(manifest, 201);
    } catch (error) {
      console.error("[Track Imagery] Venue package import failed:", error);
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
  .get("/api/dev/track-imagery/venues/texture/:textureId", async (c) => {
    try {
      const venueId = venueIdFromQuery(c);
      const textureId = c.req.param("textureId") === "base" ? "base" : safeId(c.req.param("textureId"), "Texture ID");
      const venue = loadTrackImageryVenue(venueId);
      if (!venue) return c.json({ error: "Imagery venue not found" }, 404);
      if (textureId === "base") {
        const path = imageryPackPath(venueId);
        if (!existsSync(path)) return c.json({ error: "Imagery package not found" }, 404);
        const preview = await renderImageryPackPreview(path);
        return new Response(Uint8Array.from(preview.bytes).buffer, {
          headers: { "Cache-Control": "no-store", "Content-Type": "image/webp", "X-Imagery-Height": String(preview.height), "X-Imagery-Width": String(preview.width) },
        });
      }
      const fileName = venue.layers.find((layer) => layer.id === textureId)?.image;
      if (!fileName) return c.json({ error: "Imagery texture not found" }, 404);
      const path = resolve(trackImageryVenueDirectory(venueId), "layers", fileName);
      if (!existsSync(path)) return c.json({ error: "Imagery texture file not found" }, 404);
      return new Response(Bun.file(path), { headers: { "Cache-Control": "no-store", "Content-Type": trackImageryContentType(path) } });
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
      const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(String(form.get("manifest") ?? "null")));
      const rawBase: Record<string, unknown> = raw.base && typeof raw.base === "object" && raw.base !== null ? (raw.base as Record<string, unknown>) : {};
      const rawSource: Record<string, unknown> = "source" in rawBase && rawBase.source && typeof rawBase.source === "object" ? (rawBase.source as Record<string, unknown>) : {};
      const sourceResolutionM = "sourceResolutionM" in rawSource && typeof rawSource.sourceResolutionM === "number" && rawSource.sourceResolutionM > 0 ? rawSource.sourceResolutionM : undefined;
      const storedResolutionM = sourceResolutionM ? Math.max(sourceResolutionM, 0.1) : undefined;
      const bounds = TrackImageryGeographicBoundsSchema.parse("bounds" in rawBase ? rawBase.bounds : undefined);
      const tileSize = 512;
      const scale = sourceResolutionM && storedResolutionM ? Math.min(1, sourceResolutionM / storedResolutionM) : 1;
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const columns = Math.ceil(width / tileSize);
      const rows = Math.ceil(height / tileSize);
      const source = {
        ...rawSource,
        provider: typeof rawSource.provider === "string" && rawSource.provider.trim() ? rawSource.provider : "manual",
        name: typeof rawSource.name === "string" && rawSource.name.trim() ? rawSource.name : file.name || "Manual imagery upload",
        quality: "hq",
        ...(sourceResolutionM ? { sourceResolutionM, storedResolutionM } : {}),
      };
      const manifest = TrackImageryVenueManifestSchema.parse({
        ...raw,
        version: TRACK_IMAGERY_MANIFEST_VERSION,
        venueId,
        base: { pack: TRACK_IMAGERY_PACKAGE_NAME, tileSize, bounds, source },
      });
      const directory = trackImageryVenueDirectory(venueId);
      await writeTrackImageryPack(
        imageryPackPath(venueId),
        {
          schemaVersion: 1,
          tier: "hq",
          width,
          height,
          tileSize,
          columns,
          rows,
          ...(storedResolutionM ? { resolutionM: storedResolutionM } : {}),
          bounds,
        },
        manualImageryTiles(image, tileSize, width, height),
      );
      removeLooseBaseFiles(directory);
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
        version: TRACK_IMAGERY_MANIFEST_VERSION,
        venueId,
        base: current.base,
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
      const layout = TrackImageryLayoutManifestSchema.parse({ ...raw, version: TRACK_IMAGERY_MANIFEST_VERSION, gameId, trackOrdinal });
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
