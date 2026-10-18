import { getAMS2TrackLength, getAMS2DisplayTrackName, getAMS2SharedTrackName } from "@raceiq/game-ams2-metadata/index";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TrackIdParamSchema, GameIdQuerySchema } from "@raceiq/shared/platform/http/route-schemas";
import { getLapCountsByTrack } from "@raceiq/backend-core/db/lap-read-queries";
import { getTrackLengthMetersById, getTrackOutlineById, hasRecordedOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { loadLabelledSegments } from "@raceiq/shared/racing/tracks/storage/meta";
import { loadSharedOutline } from "@raceiq/shared/racing/tracks/geometry/shared";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { getAcEvoTracks, getAcEvoTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getLMUTrack, getLMUTrackByAssetName, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { computeOutlineLength, resolveTrackOutline } from "./support";
import { getIRacingTrack, getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";


export const trackCatalogInfoRoutes = new Hono()
  .get("/api/lmu-assets/tracks/:asset", (c) => {
    const track = getLMUTrackByAssetName(c.req.param("asset"));
    if (!track) return c.json({ error: "LMU track asset not found" }, 404);
    const file = resolve(gameAssetsDir("lmu"), track.boundariesSvg);
    if (!existsSync(file)) return c.json({ error: "LMU track asset not found" }, 404);
    return new Response(readFileSync(file), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  })
  .get("/api/iracing-assets/tracks/:trackId", (c): Response => {
    const ordinal = Number(c.req.param("trackId"));
    const track = getIRacingTrack(ordinal);
    if (!track) return c.json({ error: "iRacing track asset not found" }, 404);
    const file = resolve(
      gameAssetsDir("iracing"),
      "iracing-track-maps",
      `${ordinal}.svg`,
    );
    if (!existsSync(file)) {
      return c.json({ error: "iRacing track asset not found" }, 404);
    }
    return new Response(readFileSync(file), {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })


  // GET /api/tracks/:trackId (info)
  .get("/api/tracks/:trackId",
    zValidator("param", TrackIdParamSchema),
    (c) => {
      const trackId = Number(c.req.valid("param").trackId);
      if (!Number.isInteger(trackId)) return c.json({ error: "Track not found" }, 404);
      const track = fmTrackCatalog.get(trackId);
      if (!track) return c.json({ error: "Track not found" }, 404);
      return c.json({ id: String(trackId), ...track });
    }
  )

  // GET /api/track-name/:trackId — plain text
  .get(
    "/api/track-name/:trackId",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const trackKey = c.req.valid("param").trackId;
      const { gameId } = c.req.valid("query");
      if (gameId === "lmu") return c.text(getLMUTrack(trackKey)?.name ?? trackKey);
      if (gameId === "ac-evo") return c.text(getAcEvoTrackName(trackKey) ?? trackKey);
      if (gameId === "iracing") return c.text(getIRacingTrack(Number(trackKey))?.name ?? "Unknown track");
      const serverAdapter = gameId ? tryGetServerGame(gameId) : undefined;
      if (serverAdapter) return c.text(serverAdapter.getTrackName(trackKey));
      return c.text(resolveTrackName(trackKey, gameId));
    },
  );

export const trackCatalogRoutes = new Hono()

  // GET /api/tracks — list all tracks with outline availability and lap counts
  .get("/api/tracks",
    async (c) => {
      const gameId = c.req.query("gameId");

      if (gameId === "f1-2025") {
        const f1Tracks = getF1Tracks();
        const lapCounts = await getLapCountsByTrack("f1-2025");
        const tracks = Array.from(f1Tracks.entries()).map(([id, info]) => {
          const trackId = String(id);
          const hasBundled = !!getTrackOutlineById(trackId, "f1-2025", info.commonTrackName);
          return {
            id: trackId,
            name: info.name,
            location: info.location,
            country: info.country,
            variant: info.variant,
            lengthKm: info.lengthKm,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            commonTrackName: info.commonTrackName || null,
            createdAt: null,
            lapCount: lapCounts.get(trackId) ?? 0,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      if (gameId === "acc") {
        const accTracks = getAccTracks();
        const lapCounts = await getLapCountsByTrack("acc");
        const tracks = Array.from(accTracks.entries()).map(([id, info]) => {
          const trackId = String(id);
          const outline = getTrackOutlineById(trackId, "acc", info.commonTrackName ?? undefined);
          const hasBundled = !!outline;
          return {
            id: trackId,
            name: info.name,
            location: "",
            country: "",
            variant: info.variant,
            lengthKm: Math.round(computeOutlineLength(outline) / 10) / 100,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            createdAt: null,
            lapCount: lapCounts.get(trackId) ?? 0,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      if (gameId === "ac-evo") {
        const lapCounts = await getLapCountsByTrack("ac-evo");
        const tracks = await Promise.all(Array.from(getAcEvoTracks().entries()).map(async ([id, info]) => {
          const outline = await resolveTrackOutline(id, "ac-evo");
          return {
            id,
            name: info.name,
            location: "",
            country: "",
            variant: info.variant,
            lengthKm: Math.round((getTrackLengthMetersById(id, "ac-evo", info.commonTrackName || undefined) ?? 0) / 10) / 100,
            hasOutline: !!outline?.points.length,
            outlineSource: outline?.points.length ? outline.source : null,
            createdAt: null,
            lapCount: lapCounts.get(id) ?? 0,
          };
        }));
        tracks.sort((a, b) => a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant));
        return c.json(tracks);
      }
      if (gameId === "lmu") {
        const lapCounts = await getLapCountsByTrack("lmu");
        const tracks = lmuTrackCatalog.map((track) => {
          return {
            id: track.id,
            name: track.name,
            location: track.location,
            country: track.countryCode,
            variant: track.layout,
            lengthKm: track.lengthKm,
            category: track.event,
            commonTrackName: track.commonTrackName ?? null,
            hasOutline: false,
            hasMap: true,
            mapUrl: `/api/lmu-assets/tracks/${encodeURIComponent(track.boundariesSvg.split("/").pop()!)}`,
            outlineSource: "extracted",
            createdAt: null,
            lapCount: lapCounts.get(track.id) ?? 0,
          };
        });
        const discovered = (await listDiscoveredTracks("lmu")).map((track) => ({
          id: track.trackId,
          name: track.name,
          location: "",
          country: "",
          variant: "",
          lengthKm: 0,
          category: "discovered",
          commonTrackName: null,
          hasOutline: hasRecordedOutlineById(track.trackId, "lmu"),
          hasMap: hasRecordedOutlineById(track.trackId, "lmu"),
          mapUrl: null,
          outlineSource: "generated",
          createdAt: track.createdAt,
          lapCount: lapCounts.get(track.trackId) ?? 0,
        }));
        return c.json([...tracks, ...discovered].sort((left, right) => left.name.localeCompare(right.name)));
      }

      if (gameId === "ams2") {
        const counts = await getLapCountsByTrack("ams2");
        const tracks = (await listDiscoveredTracks("ams2")).map(track => {
          const hasOutline = hasRecordedOutlineById(track.trackId, "ams2");
          return {id: track.trackId, name: getAMS2DisplayTrackName(track.trackId), location: "", country: "", variant: "",
            lengthKm: (getAMS2TrackLength(track.trackId) ?? getTrackLengthMetersById(track.trackId, "ams2") ?? 0) / 1000,
            category: "", hasOutline, hasMap: hasOutline, mapUrl: null,
            outlineSource: hasOutline ? "generated" : null, commonTrackName: getAMS2SharedTrackName(track.trackId) ?? null,
            createdAt: track.createdAt, lapCount: counts.get(track.trackId) ?? 0};
        });
        return c.json(tracks.sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (gameId === "iracing") {
        const lapCounts = await getLapCountsByTrack("iracing");
        const catalogTracks = getAllIRacingTracks();
        const catalogIds = new Set(
          catalogTracks.map((track) => String(track.ordinal)),
        );
        const catalogEntries = catalogTracks.map((info) => {
          const hasShared = !!(
            info.commonTrackName &&
            loadSharedOutline(info.commonTrackName) &&
            loadLabelledSegments(
              info.commonTrackName,
              "iracing",
            ).length > 0
          );
          const hasGenerated = hasRecordedOutlineById(
            String(info.ordinal),
            "iracing",
          );
          const hasOfficialSvg = !!info.mapUrl;
          const hasOutline =
            hasShared || hasOfficialSvg || hasGenerated;
          return {
            id: String(info.ordinal),
            name: info.name,
            location: info.location,
            country: info.country,
            variant: info.variant,
            lengthKm: info.lengthKm,
            category: info.category,
            cornersPerLap: info.cornersPerLap,
            pitRoadSpeedLimitMph: info.pitRoadSpeedLimitMph,
            numberPitStalls: info.numberPitStalls,
            maxCars: info.maxCars,
            nightLighting: info.nightLighting,
            rainEnabled: info.rainEnabled,
            latitude: info.latitude,
            longitude: info.longitude,
            timeZone: info.timeZone,
            pitMapUrl: info.pitMapUrl || null,
            startFinishMapUrl: info.startFinishMapUrl || null,
            turnsMapUrl: info.turnsMapUrl || null,
            hasOutline,
            hasMap: hasOutline,
            mapUrl: info.mapUrl
              ? `/api/iracing-assets/tracks/${info.ordinal}`
              : null,
            outlineSource: hasShared
              ? "shared"
              : hasOfficialSvg
                ? "official-svg"
                : hasGenerated
                  ? "generated"
                  : null,
            commonTrackName: info.commonTrackName || null,
            createdAt: null,
            lapCount: lapCounts.get(String(info.ordinal)) ?? 0,
          };
        });
        const discoveredOnly = (await listDiscoveredTracks("iracing"))
          .filter((track) => !catalogIds.has(track.trackId))
          .map((track) => ({
            id: track.trackId,
            name: track.name,
            location: "",
            country: "",
            variant: "",
            lengthKm: 0,
            category: "",
            cornersPerLap: null,
            pitRoadSpeedLimitMph: null,
            numberPitStalls: null,
            maxCars: null,
            nightLighting: null,
            rainEnabled: null,
            latitude: null,
            longitude: null,
            timeZone: null,
            pitMapUrl: null,
            startFinishMapUrl: null,
            turnsMapUrl: null,
            hasOutline: false,
            hasMap: false,
            mapUrl: null,
            outlineSource: null,
            commonTrackName: null,
            createdAt: track.createdAt,
            lapCount: lapCounts.get(track.trackId) ?? 0,
          }));
        const tracks = [...catalogEntries, ...discoveredOnly];
        tracks.sort((a, b) => {
          if (a.hasOutline !== b.hasOutline) {
            return a.hasOutline ? -1 : 1;
          }
          return a.name.localeCompare(b.name) ||
            a.variant.localeCompare(b.variant);
        });
        return c.json(tracks);
      }

      if (gameId !== "fm-2023") {
        return c.json({ error: `unknown or missing gameId: ${gameId ?? "(none)"}` }, 400);
      }

      const lapCounts = await getLapCountsByTrack("fm-2023");
      const tracks = Array.from(fmTrackCatalog.entries()).map(([ordinal, info]) => {
        const trackId = String(ordinal);
        const hasBundled = !!getTrackOutlineById(trackId, "fm-2023");
        return {
          id: trackId,
          name: info.name,
          location: info.location,
          country: info.country,
          variant: info.variant,
          lengthKm: info.lengthKm,
          hasOutline: hasBundled,
          outlineSource: hasBundled ? "bundled" : null,
          createdAt: null,
          lapCount: lapCounts.get(trackId) ?? 0,
        };
      });
      // Sort: tracks with outlines first, then alphabetically
      tracks.sort((a, b) => {
        if (a.hasOutline !== b.hasOutline) return a.hasOutline ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return c.json(tracks);
    }
  );
