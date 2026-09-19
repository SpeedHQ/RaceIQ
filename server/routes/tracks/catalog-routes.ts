import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OrdinalParamSchema, GameIdQuerySchema } from "@shared/platform/http/route-schemas";
import { getLapCountsByTrack } from "../../db/lap-read-queries";
import { getTrackOutlineByOrdinal, hasRecordedOutline as sharedHasRecordedOutline } from "../../../shared/racing/tracks/recording/outlines";
import { loadLabelledSegments } from "../../../shared/racing/tracks/storage/meta";
import { loadSharedOutline } from "../../../shared/racing/tracks/geometry/shared";
import { resolveTrackName } from "../../../shared/racing/tracks/resolve-name";
import { fmTrackCatalog } from "../../../shared/racing/tracks/catalogs/fm";
import { getF1Tracks } from "../../../shared/racing/tracks/catalogs/f1";
import { getAccTracks } from "../../../shared/racing/tracks/catalogs/acc";
import { getAcEvoTracks } from "../../../shared/racing/tracks/catalogs/ac-evo";
import { getAllIRacingTracks } from "../../../shared/racing/tracks/catalogs/iracing";
import { getLMUTrackByAssetName, lmuTrackCatalog } from "../../../shared/games/lmu/catalog";
import { lmuIdentityOrdinal } from "../../../shared/games/lmu";
import { GAMES_DIR } from "../../runtime/config/paths";
import { tryGetServerGame } from "../../games/registry";
import { listDiscoveredTracks } from "../../db/discovered-tracks";


export const trackCatalogInfoRoutes = new Hono()
  .get("/api/lmu-assets/tracks/:asset", (c) => {
    const track = getLMUTrackByAssetName(c.req.param("asset"));
    if (!track) return c.json({ error: "LMU track asset not found" }, 404);
    const file = resolve(GAMES_DIR, "lmu", track.boundariesSvg);
    if (!existsSync(file)) return c.json({ error: "LMU track asset not found" }, 404);
    return new Response(readFileSync(file), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  })

  // GET /api/tracks/:ordinal (info)
  .get("/api/tracks/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      const track = fmTrackCatalog.get(ordinal);
      if (!track) return c.json({ error: "Track not found" }, 404);

      return c.json({ ordinal, ...track });
    }
  )

  // GET /api/track-name/:ordinal — plain text
  .get(
    "/api/track-name/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const serverAdapter = gameId ? tryGetServerGame(gameId) : undefined;
      if (serverAdapter) return c.text(serverAdapter.getTrackName(ordinal));
      return c.text(resolveTrackName(ordinal, gameId));
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
          const hasBundled = !!getTrackOutlineByOrdinal(id, "f1-2025", info.commonTrackName);
          return {
            ordinal: id,
            name: info.name,
            location: info.location,
            country: info.country,
            variant: info.variant,
            lengthKm: info.lengthKm,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            commonTrackName: info.commonTrackName || null,
            createdAt: null,
            lapCount: lapCounts.get(id) ?? 0,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      if (gameId === "acc") {
        const accTracks = getAccTracks();
        const lapCounts = await getLapCountsByTrack("acc");
        const tracks = Array.from(accTracks.entries()).map(([id, info]) => {
          const hasBundled = !!getTrackOutlineByOrdinal(id, "acc", info.commonTrackName ?? undefined);
          return {
            ordinal: id,
            name: info.name,
            location: "",
            country: "",
            variant: info.variant,
            lengthKm: 0,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            createdAt: null,
            lapCount: lapCounts.get(id) ?? 0,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      if (gameId === "ac-evo") {
        const acEvoTracks = getAcEvoTracks();
        const lapCounts = await getLapCountsByTrack("ac-evo");
        const tracks = Array.from(acEvoTracks.entries()).map(([id, info]) => {
          const hasBundled = !!getTrackOutlineByOrdinal(id, "ac-evo", info.commonTrackName ?? undefined);
          return {
            ordinal: id,
            name: info.name,
            location: "",
            country: "",
            variant: info.variant,
            lengthKm: 0,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            createdAt: null,
            lapCount: lapCounts.get(id) ?? 0,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }
      if (gameId === "lmu") {
        const lapCounts = await getLapCountsByTrack("lmu");
        const tracks = lmuTrackCatalog.map((track) => {
          const ordinal = lmuIdentityOrdinal("track", track.layout);
          return {
            id: track.id,
            ordinal,
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
            lapCount: lapCounts.get(ordinal) ?? 0,
          };
        });
        const discovered = (await listDiscoveredTracks("lmu")).map((track) => ({
          id: null,
          ordinal: track.ordinal,
          name: track.name,
          location: "",
          country: "",
          variant: "",
          lengthKm: 0,
          category: "discovered",
          commonTrackName: null,
          hasOutline: sharedHasRecordedOutline(track.ordinal, "lmu"),
          hasMap: sharedHasRecordedOutline(track.ordinal, "lmu"),
          mapUrl: null,
          outlineSource: "generated",
          createdAt: track.createdAt,
          lapCount: lapCounts.get(track.ordinal) ?? 0,
        }));
        return c.json([...tracks, ...discovered].sort((left, right) => left.name.localeCompare(right.name)));
      }

      if (gameId === "iracing") {
        const lapCounts = await getLapCountsByTrack("iracing");
        const catalogTracks = getAllIRacingTracks();
        const catalogIds = new Set(
          catalogTracks.map((track) => track.ordinal),
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
          const hasGenerated = sharedHasRecordedOutline(
            info.ordinal,
            "iracing",
          );
          const hasOfficialSvg = !!info.mapUrl;
          const hasOutline =
            hasShared || hasOfficialSvg || hasGenerated;
          return {
            ordinal: info.ordinal,
            name: info.name,
            location: info.location,
            country: info.country,
            variant: info.variant,
            lengthKm: info.lengthKm,
            category: info.category,
            hasOutline,
            hasMap: hasOutline,
            mapUrl: info.mapUrl || null,
            outlineSource: hasShared
              ? "shared"
              : hasOfficialSvg
                ? "official-svg"
                : hasGenerated
                  ? "generated"
                  : null,
            commonTrackName: info.commonTrackName || null,
            createdAt: null,
            lapCount: lapCounts.get(info.ordinal) ?? 0,
          };
        });
        const discoveredOnly = (await listDiscoveredTracks("iracing"))
          .filter((track) => !catalogIds.has(track.ordinal))
          .map((track) => ({
            ordinal: track.ordinal,
            name: track.name,
            location: "",
            country: "",
            variant: "",
            lengthKm: 0,
            category: "",
            hasOutline: false,
            hasMap: false,
            mapUrl: null,
            outlineSource: null,
            commonTrackName: null,
            createdAt: track.createdAt,
            lapCount: lapCounts.get(track.ordinal) ?? 0,
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
        const hasBundled = !!getTrackOutlineByOrdinal(ordinal, "fm-2023");
        return {
          ordinal,
          name: info.name,
          location: info.location,
          country: info.country,
          variant: info.variant,
          lengthKm: info.lengthKm,
          hasOutline: hasBundled,
          outlineSource: hasBundled ? "bundled" : null,
          createdAt: null,
          lapCount: lapCounts.get(ordinal) ?? 0,
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
