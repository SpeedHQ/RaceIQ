import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IS_DEV, IS_E2E } from "../../runtime/config/env";
import { OrdinalParamSchema, GameIdQuerySchema, RequiredGameIdQuerySchema } from "@shared/platform/http/route-schemas";
import { tryGetGame } from "../../../shared/games/registry";
import { tryGetServerGame } from "../../games/registry";
import { formatTurnNumbers, turnNumbers } from "../../../shared/racing/tracks/segment-label";
import type { NamedSegment } from "../../../shared/racing/tracks/named-segments";
import { trackConfigurationCanonicalId } from "../../../shared/racing/tracks/configuration";
import { getCorners, saveCorners } from "../../db/track-queries";
import { getLapById, getLapSummariesByTrack } from "../../db/lap-read-queries";
import { getTrackOutlineByOrdinal } from "../../../shared/racing/tracks/recording/outlines";
import { getTrackSectorsByOrdinal } from "../../../shared/racing/tracks/storage/sectors";
import {
  loadTrackFacts,
  loadTrackGeometryForGame,
  loadTrackSectorsFor,
  saveTrackGeometry,
  saveTrackMetadata,
} from "../../../shared/racing/tracks/storage/meta";
import { resolveTrackName } from "../../../shared/racing/tracks/resolve-name";
import { getTrackGuide } from "../../ai/track-guides";
import type { Corner } from "../../lap-analysis/corners";
import { isValidNativeSectorStarts } from "../../lap-analysis/sectors";
import { cornerNumbers } from "../../../shared/racing/tracks/facts";
import { splitSegments } from "../../../shared/racing/tracks/curation/join";
import { cornerKey } from "../../../shared/racing/tracks/keys";
import { loadTrackConfiguration } from "../../tracks/configuration";
import {
  generateTrackSegments,
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
  // Telemetry detection does not happen here; stored-lap analysis resolves its
  // own metre-based corners, while the PUT handler owns manual edits.
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

  .put("/api/tracks/:trackOrdinal/corners",
    zValidator("param", TrackOrdinalParamSchema),
    zValidator("query", RequiredGameIdQuerySchema),
    async (c) => {
      if (!IS_DEV && !IS_E2E) return c.json({ error: "Not available in production" }, 403);
      const { trackOrdinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
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

      await saveCorners(trackOrdinal, body, gameId, false);
      return c.json({ success: true, count: body.length });
    }
  );

export const trackSectorBoundaryRoutes = new Hono()

  // GET /api/track-sector-boundaries/:ordinal — returns s1End/s2End fractions for timing
  .get("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", RequiredGameIdQuerySchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const adapter = tryGetGame(gameId) ?? tryGetServerGame(gameId);

      // Native games own timing sectors. RaceIQ's stored S1/S2 values are
      // not an effective fallback when no native lap layout is recorded.
      const outline = getTrackOutlineByOrdinal(ordinal, gameId, getSharedTrackName(ordinal, gameId));
      const trackLength = computeOutlineLength(outline);
      if (adapter?.nativeSectors) {
        let sectorStarts: number[] | null = null;
        if (adapter.getNativeSectorLayout) {
          const laps = await getLapSummariesByTrack(ordinal, gameId);
          laps.sort((left, right) => {
            const dateDelta = new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
            return dateDelta || right.lapId - left.lapId;
          });
          for (const summary of laps) {
            const lap = await getLapById(summary.lapId);
            for (const packet of lap?.telemetry ?? []) {
              const starts = adapter.getNativeSectorLayout(packet)?.starts;
              if (!isValidNativeSectorStarts(starts)) continue;
              sectorStarts = [...starts];
              break;
            }
            if (sectorStarts) break;
          }
        }
        return c.json({
          ownership: "game" as const,
          editable: false as const,
          sectorStarts,
          trackLength,
        });
      }

      const sharedName = getSharedTrackName(ordinal, gameId);
      const sectors = (sharedName ? loadTrackSectorsFor(sharedName, gameId) : undefined)
        ?? getTrackSectorsByOrdinal(ordinal);
      return c.json({
        ...sectors,
        ownership: "raceiq" as const,
        editable: true as const,
        sectorStarts: [0, sectors.s1End, sectors.s2End],
        trackLength,
      });
    }
  )

  // PUT /api/track-sector-boundaries/:ordinal — update s1End/s2End fractions (dev only)
  .put("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", RequiredGameIdQuerySchema),
    async (c) => {
      if (!IS_DEV && !IS_E2E) return c.json({ error: "Not available in production" }, 403);
      const { ordinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");

      // Check ownership before reading the body. Native-sector callers must
      // receive this stable conflict even when their payload is malformed.
      if ((tryGetGame(gameId) ?? tryGetServerGame(gameId))?.nativeSectors) {
        return c.json({
          error: "native-sectors-read-only",
          message: "Native sector boundaries are supplied by the game and cannot be edited",
        }, 409);
      }

      const body = await c.req.json();
      const { s1End, s2End } = body;
      if (!Number.isFinite(s1End) || !Number.isFinite(s2End)) {
        return c.json({ error: "s1End and s2End numbers required" }, 400);
      }
      if (s1End <= 0 || s1End >= s2End || s2End >= 1) {
        return c.json({ error: "Invalid sector boundaries: need 0 < s1End < s2End < 1" }, 400);
      }

      const slug = getSharedTrackName(ordinal, gameId);

      // Sector boundaries are lap fractions, so they live with the rest of this
      // game's geometry rather than in the shared facts.
      if (slug) {
        const existingGeometry = loadTrackGeometryForGame(slug, gameId);
        saveTrackGeometry(slug, gameId, {
          sectors: { s1End, s2End },
          segments: existingGeometry?.segments ?? [],
        });
      }

      return c.json({ success: true, s1End, s2End });
    }
  );

export const trackSegmentRoutes = new Hono()

  // PUT /api/tracks/:trackOrdinal/segments — save segments to shared meta (dev only)
  .put("/api/tracks/:trackOrdinal/segments",
    zValidator("param", TrackOrdinalParamSchema),
    zValidator("query", RequiredGameIdQuerySchema),
    async (c) => {
      if (!IS_DEV && !IS_E2E) return c.json({ error: "Not available in production" }, 403);
      const { trackOrdinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");

      const body = await c.req.json();
      if (!body.segments || !Array.isArray(body.segments)) {
        return c.json({ error: "segments array required" }, 400);
      }

      const configuration = loadTrackConfiguration(gameId, trackOrdinal);
      const configurationSlug = configuration ? trackConfigurationCanonicalId(configuration).replaceAll("/", "-") : undefined;
      const slug = getSharedTrackName(trackOrdinal, gameId) ?? configurationSlug;
      if (!slug) {
        return c.json({ error: "No track configuration for this ordinal" }, 400);
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

      // Editor save is edit, not sign-off — registry verification hash goes
      // stale on next check. Citation is carried outright: uncited name is
      // indistinguishable
      // from an invented one.
      const existingGeometry = loadTrackGeometryForGame(slug, gameId);
      saveTrackMetadata(slug, {
        slug,
        track: existing?.track ?? configuration?.venue.id ?? slug,
        layout: existing?.layout ?? configuration?.track.id ?? "full",
        layoutName: existing?.layoutName ?? configuration?.track.name ?? "Full",
        name: existing?.name ?? configuration?.venue.name ?? slug,
        ...(existing?.source ? { source: existing.source } : {}),
        corners: [...byKey.values()].sort((a, b) => a.number - b.number),
        straights: [...byAfter.values()].sort((a, b) => a.after - b.after),
      }, {
        [gameId]: {
          ...(existingGeometry?.sectors ? { sectors: existingGeometry.sectors } : {}),
          segments: geometry,
        },
      }, {
        gameId,
        trackOrdinal,
      });
      console.log(`[Track] Saved ${geometry.length} segments for ${slug} (${gameId})`);

      return c.json({ success: true, count: body.segments.length });
    }
  )

  // POST /api/tracks/:trackOrdinal/segments/generate — create an unsaved editor preview.
  .post("/api/tracks/:trackOrdinal/segments/generate",
    zValidator("param", TrackOrdinalParamSchema),
    zValidator("query", RequiredGameIdQuerySchema),
    async (c) => {
      if (!IS_DEV && !IS_E2E) return c.json({ error: "Not available in production" }, 403);
      const { trackOrdinal } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const generated = await generateTrackSegments(trackOrdinal, gameId);
      return c.json(generated);
    }
  )

  // GET /api/track-sectors/:ordinal — returns persisted registry segments.
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
