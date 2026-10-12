import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IS_DEV } from "@raceiq/backend-core/runtime/config/env";
import { TrackIdParamSchema, GameIdQuerySchema } from "@raceiq/shared/platform/http/route-schemas";
import { formatTurnNumbers, turnNumbers } from "@raceiq/shared/racing/tracks/segment-label";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { getCorners, saveCorners } from "@raceiq/backend-core/db/track-queries";
import { getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { resolveTrack } from "@raceiq/backend-core/tracks/info";
import {
  loadTrackFacts,
  loadTrackGeometry,
  loadTrackSectorsFor,
  saveTrackFacts,
  saveTrackGeometry,
} from "@raceiq/shared/racing/tracks/storage/meta";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { getTrackGuide } from "@raceiq/backend-core/ai/track-guides";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import { cornerNumbers } from "@raceiq/shared/racing/tracks/facts";
import { getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { splitSegments } from "@raceiq/shared/racing/tracks/curation/join";
import { cornerKey } from "@raceiq/shared/racing/tracks/keys";
import {
  computeOutlineLength,
  getSharedTrackName,
  requireGameId,
  resolveTrackSegments,
  resolveTrackOutline,
} from "./support";

export const trackCornerRoutes = new Hono()

  // GET /api/tracks/:trackId/corners — authoritative corner fractions
  // (0..1 lap fraction, matching the track-focus map/lanes contract).
  //
  // Priority:
  //   a. Curated track-context segments (type === "corner") — already
  //      lap-fraction, game-specific. This is the ground truth.
  //   b. Stored/auto-detected DB corners, which are in METERS — converted to
  //      fractions using the same outline-length calc as
  //      GET /api/track-sector-boundaries/:trackId.
  //   c. Empty array — the client falls back to telemetry-based detection.
  // Telemetry detection does not happen here; stored-lap analysis resolves its
  // own metre-based corners, while the PUT handler owns manual edits.
  .get("/api/tracks/:trackId/corners",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const cornersGameId = requireGameId(c);

      // (a) Segments — already fractions. Same resolver (curated first, then
      // the auto-detector on the outline) that GET /api/track-sectors/:trackId
      // uses, so track detail and the review dashboard agree.
      const { segments } = await resolveTrackSegments(trackId, cornersGameId);
      const cornerSegments = segments.filter((s) => s.type === "corner");
      if (cornerSegments.length > 0) {
        const corners: Corner[] = cornerSegments.map((s, index) => ({
          index,
          // Review dashboard shows turn numbers only — drop community/known
          // corner names, keep "T<number>" (range for multi-turn segments).
          label: turnNumbers(s).length > 0 ? `T${formatTurnNumbers(turnNumbers(s))}` : `T${index + 1}`,
          distanceStart: s.startFrac,
          distanceEnd: s.endFrac,
        }));
        return c.json(corners);
      }

      // (b) Stored DB corners, in meters — convert to fractions.
      const dbCorners = await getCorners(trackId, cornersGameId);
      if (dbCorners.length > 0) {
        const resolved = await resolveTrackOutline(trackId, cornersGameId);
        const trackLength = computeOutlineLength(resolved?.points);
        if (trackLength > 0) {
          const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
          const corners: Corner[] = dbCorners.map((corner) => ({
            ...corner,
            distanceStart: clamp01(corner.distanceStart / trackLength),
            distanceEnd: clamp01(corner.distanceEnd / trackLength),
            apexDistance: corner.apexDistance != null ? clamp01(corner.apexDistance / trackLength) : undefined,
          }));
          return c.json(corners);
        }
      }

      // (c) No authoritative source — client falls back to telemetry detection.
      return c.json([]);
    }
  )

  // PUT /api/tracks/:trackId/corners — save/update corner definitions
  .put("/api/tracks/:trackId/corners",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      const { trackId } = c.req.valid("param");

      const body = await c.req.json<Corner[]>();

      if (!Array.isArray(body)) {
        return c.json({ error: "Body must be an array of corner definitions" }, 400);
      }

      // Validate each corner
      for (const corner of body) {
        if (
          typeof corner.index !== "number" ||
          typeof corner.label !== "string" ||
          typeof corner.distanceStart !== "number" ||
          typeof corner.distanceEnd !== "number"
        ) {
          return c.json(
            { error: "Each corner must have index, label, distanceStart, distanceEnd" },
            400
          );
        }
        if (corner.distanceEnd <= corner.distanceStart) {
          return c.json(
            { error: `Corner ${corner.label}: distanceEnd must be > distanceStart` },
            400
          );
        }
      }

      await saveCorners(trackId, body, requireGameId(c), false);
      return c.json({ success: true, count: body.length });
    }
  );

export const trackSectorBoundaryRoutes = new Hono()

  // GET /api/track-sector-boundaries/:trackId — returns s1End/s2End fractions for timing
  .get("/api/track-sector-boundaries/:trackId",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      if (gameId === "lmu") {
        const track = getLMUTrack(trackId);
        return c.json({
          s1End: track?.sectorFractions?.[0] ?? 1 / 3,
          s2End: track?.sectorFractions?.[1] ?? 2 / 3,
          trackLength: (track?.lengthKm ?? 0) * 1_000,
        });
      }
      const resolved = gameId ? await resolveTrackOutline(trackId, gameId) : null;
      if (resolved?.closed === false) {
        return c.json({ s1End: 1 / 3, s2End: 2 / 3, trackLength: computeOutlineLength(resolved.points) });
      }
      const sharedName = getSharedTrackName(trackId, gameId);
      const sectors = (sharedName && gameId ? loadTrackSectorsFor(sharedName, gameId) : undefined)
        ?? resolveTrack(gameId, trackId).sectors;
      const outline = gameId ? getTrackOutlineById(trackId, gameId, sharedName) : null;
      const trackLength = computeOutlineLength(outline);
      return c.json({ ...sectors, trackLength });
    }
  )
  // PUT /api/track-sector-boundaries/:trackId — update s1End/s2End fractions (dev only)
  .put("/api/track-sector-boundaries/:trackId",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { trackId } = c.req.valid("param");

      const body = await c.req.json();
      const { s1End, s2End } = body;
      if (typeof s1End !== "number" || typeof s2End !== "number") {
        return c.json({ error: "s1End and s2End numbers required" }, 400);
      }
      if (s1End <= 0 || s1End >= s2End || s2End >= 1) {
        return c.json({ error: "Invalid sector boundaries: need 0 < s1End < s2End < 1" }, 400);
      }

      const gameId = c.req.query("gameId");
      const slug = getSharedTrackName(trackId, gameId);

      // Sector boundaries are lap fractions, so they live with the rest of this
      // game's geometry rather than in the shared facts.
      if (slug && gameId) {
        const geometry = loadTrackGeometry(slug, gameId);
        saveTrackGeometry(slug, gameId, {
          ...(geometry?.override !== undefined ? { override: geometry.override } : {}),
          sectors: { s1End, s2End },
          segments: geometry?.segments ?? [],
        });
      }

      return c.json({ success: true, s1End, s2End });
    }
  );

export const trackSegmentRoutes = new Hono()

  // PUT /api/tracks/:trackId/segments — save segments to shared meta (dev only)
  .put("/api/tracks/:trackId/segments",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { trackId } = c.req.valid("param");
      const gameId = c.req.query("gameId");

      const body = await c.req.json();
      if (!body.segments || !Array.isArray(body.segments)) {
        return c.json({ error: "segments array required" }, 400);
      }

      const slug = getSharedTrackName(trackId, gameId);
      if (!slug) {
        return c.json({ error: "No shared track name for this identity" }, 400);
      }
      if (!gameId) {
        return c.json({ error: "gameId required: fractions are always game-specific" }, 400);
      }

      // The editor hands back joined segments, so split them: fractions belong
      // to this game, names and groups to the layout every game shares.
      const { corners, straights, geometry } = splitSegments(body.segments as NamedSegment[]);

      // Merge rather than replace. The payload only covers the corners this
      // game actually drives, and a game whose detector misses a turn must not
      // delete that turn for every other game.
      const existing = loadTrackFacts(slug);
      const byKey = new Map((existing?.corners ?? []).map((c) => [cornerKey(cornerNumbers(c)), c]));
      for (const c of corners) byKey.set(cornerKey(cornerNumbers(c)), c);
      const byAfter = new Map((existing?.straights ?? []).map((s) => [s.after, s]));
      for (const s of straights) byAfter.set(s.after, s);

      // An editor save is an edit, not a sign-off — any signature in
      // `shared/data/tracks/verified.json` goes stale on the next hash check. The
      // citation is carried outright: an uncited name is indistinguishable
      // from an invented one.
      saveTrackFacts(slug, {
        slug,
        track: existing?.track ?? slug,
        layout: existing?.layout ?? "full",
        layoutName: existing?.layoutName ?? "Full",
        name: existing?.name ?? slug,
        ...(existing?.source ? { source: existing.source } : {}),
        corners: [...byKey.values()].sort((a, b) => a.number - b.number),
        straights: [...byAfter.values()].sort((a, b) => a.after - b.after),
      });
      const existingGeometry = loadTrackGeometry(slug, gameId);
      saveTrackGeometry(slug, gameId, {
        override: true,
        ...(existingGeometry?.sectors ? { sectors: existingGeometry.sectors } : {}),
        segments: geometry,
      });
      console.log(`[Track] Saved ${geometry.length} segments for ${slug} (${gameId})`);

      return c.json({ success: true, count: body.segments.length });
    }
  )

  // GET /api/track-sectors/:trackId — returns user-edited, named, or auto-detected segments.
  .get("/api/track-sectors/:trackId",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const { segments, totalDist, source } = await resolveTrackSegments(trackId, gameId);
      if (source === "none") return c.json({ segments: [] });

      return c.json({
        segments: segments.map((s: any) => ({ ...s, startIdx: 0, endIdx: 0, distStart: 0, distEnd: 0 })),
        totalDist,
        source,
      });
    }
  )

  // GET /api/track-guide/:trackId — the expert guide for a track, as data.
  // The same knowledge the AI analyst is given, so the Info page can show what
  // the coach knows before you ask it anything.
  .get("/api/track-guide/:trackId",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      if (gameId === "lmu") {
        const track = getLMUTrack(trackId);
        return c.json(track ? getTrackGuide(track.name, { slug: track.commonTrackName }) : null);
      }
      const guide = getTrackGuide(resolveTrackName(trackId, gameId), { slug: getSharedTrackName(trackId, gameId) });
      return c.json(guide);
    }
  );
