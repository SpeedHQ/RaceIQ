import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IS_DEV } from "../../runtime/config/env";
import { OrdinalParamSchema, GameIdQuerySchema } from "../../../shared/http/route-schemas";
import { formatTurnNumbers, turnNumbers } from "../../../shared/track/segment-label";
import type { NamedSegment } from "../../../shared/track/named-segments";
import { getCorners, saveCorners } from "../../db/track-queries";
import { getTrackOutlineByOrdinal } from "../../../shared/track/recording/outlines";
import { getTrackSectorsByOrdinal } from "../../../shared/track/storage/sectors";
import {
  loadTrackFacts,
  loadTrackGeometry,
  loadTrackSectorsFor,
  saveTrackFacts,
  saveTrackGeometry,
} from "../../../shared/track/storage/meta";
import { resolveTrackName } from "../../../shared/track/resolve-name";
import { getTrackGuide } from "../../ai/track-guides";
import type { Corner } from "../../lap-analysis/corners";
import { cornerNumbers } from "../../../shared/track/facts";
import { splitSegments } from "../../../shared/track/curation/join";
import { cornerKey } from "../../../shared/track/keys";
import {
  computeOutlineLength,
  getSharedTrackName,
  requireGameId,
  resolveTrackSegments,
  TrackOrdinalParamSchema,
} from "./support";

export const trackCornerRoutes = new Hono()

  // GET /api/tracks/:trackOrdinal/corners — authoritative corner fractions
  // (0..1 lap fraction, matching the track-focus map/lanes contract).
  //
  // Priority:
  //   a. Curated track-context segments (type === "corner") — already
  //      lap-fraction, game-specific. This is the ground truth.
  //   b. Stored/auto-detected DB corners, which are in METERS — converted to
  //      fractions using the same outline-length calc as
  //      GET /api/track-sector-boundaries/:ordinal.
  //   c. Empty array — the client falls back to telemetry-based detection.
  // No telemetry auto-detection or saveCorners happens here anymore; that
  // remains the responsibility of the PUT handler and AI/comparison code
  // paths that read getCorners()/saveCorners() directly in meters.
  .get("/api/tracks/:trackOrdinal/corners",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");
      const cornersGameId = requireGameId(c);

      // (a) Segments — already fractions. Same resolver (curated first, then
      // the auto-detector on the outline) that GET /api/track-sectors/:ordinal
      // uses, so track detail and the review dashboard agree.
      const { segments } = await resolveTrackSegments(trackOrdinal, cornersGameId);
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
      const dbCorners = await getCorners(trackOrdinal, cornersGameId);
      if (dbCorners.length > 0) {
        const sharedName = getSharedTrackName(trackOrdinal, cornersGameId);
        const outline = getTrackOutlineByOrdinal(trackOrdinal, cornersGameId, sharedName);
        const trackLength = computeOutlineLength(outline);
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

  // PUT /api/tracks/:trackOrdinal/corners — save/update corner definitions
  .put("/api/tracks/:trackOrdinal/corners",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");

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

      await saveCorners(trackOrdinal, body, requireGameId(c), false);
      return c.json({ success: true, count: body.length });
    }
  );

export const trackSectorBoundaryRoutes = new Hono()

  // GET /api/track-sector-boundaries/:ordinal — returns s1End/s2End fractions for timing
  .get("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const sharedName = getSharedTrackName(ordinal, gameId);

      // Sector fractions are this game's geometry; fall back to bundled defaults.
      const sectors = (sharedName && gameId ? loadTrackSectorsFor(sharedName, gameId) : undefined)
        ?? getTrackSectorsByOrdinal(ordinal);

      // Compute track length from outline
      const outline = gameId
        ? getTrackOutlineByOrdinal(ordinal, gameId, sharedName)
        : null;
      const trackLength = computeOutlineLength(outline);
      return c.json({ ...sectors, trackLength });
    }
  )

  // PUT /api/track-sector-boundaries/:ordinal — update s1End/s2End fractions (dev only)
  .put("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { ordinal } = c.req.valid("param");

      const body = await c.req.json();
      const { s1End, s2End } = body;
      if (typeof s1End !== "number" || typeof s2End !== "number") {
        return c.json({ error: "s1End and s2End numbers required" }, 400);
      }
      if (s1End <= 0 || s1End >= s2End || s2End >= 1) {
        return c.json({ error: "Invalid sector boundaries: need 0 < s1End < s2End < 1" }, 400);
      }

      const gameId = c.req.query("gameId");
      const slug = getSharedTrackName(ordinal, gameId);

      // Sector boundaries are lap fractions, so they live with the rest of this
      // game's geometry rather than in the shared facts.
      if (slug && gameId) {
        const geometry = loadTrackGeometry(slug, gameId);
        saveTrackGeometry(slug, gameId, {
          sectors: { s1End, s2End },
          segments: geometry?.segments ?? [],
        });
      }

      return c.json({ success: true, s1End, s2End });
    }
  );

export const trackSegmentRoutes = new Hono()

  // PUT /api/tracks/:trackOrdinal/segments — save segments to shared meta (dev only)
  .put("/api/tracks/:trackOrdinal/segments",
    zValidator("param", TrackOrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { trackOrdinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");

      const body = await c.req.json();
      if (!body.segments || !Array.isArray(body.segments)) {
        return c.json({ error: "segments array required" }, 400);
      }

      const slug = getSharedTrackName(trackOrdinal, gameId);
      if (!slug) {
        return c.json({ error: "No shared track name for this ordinal" }, 400);
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
      // `shared/tracks/verified.json` goes stale on the next hash check. The
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
        ...(existingGeometry?.sectors ? { sectors: existingGeometry.sectors } : {}),
        segments: geometry,
      });
      console.log(`[Track] Saved ${geometry.length} segments for ${slug} (${gameId})`);

      return c.json({ success: true, count: body.segments.length });
    }
  )

  // GET /api/track-sectors/:ordinal — returns user-edited, named, or auto-detected segments.
  .get("/api/track-sectors/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");

      const { segments, totalDist, source } = await resolveTrackSegments(ordinal, gameId);
      if (source === "none") return c.json({ segments: [] });

      return c.json({
        segments: segments.map((s: any) => ({ ...s, startIdx: 0, endIdx: 0, distStart: 0, distEnd: 0 })),
        totalDist,
        source,
      });
    }
  )

  // GET /api/track-guide/:ordinal — the expert guide for a track, as data.
  // The same knowledge the AI analyst is given, so the Info page can show what
  // the coach knows before you ask it anything.
  .get("/api/track-guide/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const slug = getSharedTrackName(ordinal, gameId);
      const guide = getTrackGuide(resolveTrackName(ordinal, gameId as never), { slug });
      return c.json(guide);
    }
  );
