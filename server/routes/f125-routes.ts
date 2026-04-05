import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "../paths";

const F125_TUNES_DIR = resolve(SHARED_DIR, "tunes", "f1-25");

interface F125SourceMeta {
  name: string;
  slug: string;
  url?: string;
}

/** List all source directories that have _source.json */
function getSourceDirs(): { slug: string; meta: F125SourceMeta; dir: string }[] {
  if (!existsSync(F125_TUNES_DIR)) return [];
  return readdirSync(F125_TUNES_DIR)
    .filter((d) => {
      const p = resolve(F125_TUNES_DIR, d);
      return statSync(p).isDirectory() && existsSync(resolve(p, "_source.json"));
    })
    .map((d) => ({
      slug: d,
      meta: JSON.parse(readFileSync(resolve(F125_TUNES_DIR, d, "_source.json"), "utf-8")),
      dir: resolve(F125_TUNES_DIR, d),
    }));
}

/** Load track identity (slug, name, ordinal) from top-level JSON */
function loadTrackIdentity(slug: string): { trackSlug: string; trackName: string; trackOrdinal: number } | null {
  const path = resolve(F125_TUNES_DIR, `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Load setups for a track from all sources */
function loadSetupsByTrack(trackSlug: string): any[] {
  const all: any[] = [];
  for (const { slug: sourceSlug, dir: sourceDir } of getSourceDirs()) {
    const trackDir = resolve(sourceDir, trackSlug);
    if (!existsSync(trackDir)) continue;
    for (const f of readdirSync(trackDir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
      const setups: any[] = JSON.parse(readFileSync(resolve(trackDir, f), "utf-8"));
      all.push(...setups.map((s) => ({ ...s, source: sourceSlug })));
    }
  }
  return all;
}

/** Load _meta.json + leaderboard.json for a track from all sources and merge */
function loadTrackMeta(trackSlug: string): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const { dir: sourceDir } of getSourceDirs()) {
    const trackDir = resolve(sourceDir, trackSlug);

    // Merge _meta.json
    const metaPath = resolve(trackDir, "_meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      for (const [k, v] of Object.entries(meta)) {
        if (v && (!merged[k] || (Array.isArray(merged[k]) && merged[k].length === 0))) {
          merged[k] = v;
        }
      }
    }

    // Merge _leaderboard.json
    const lbPath = resolve(trackDir, "_leaderboard.json");
    if (existsSync(lbPath) && !merged.leaderboard?.length) {
      merged.leaderboard = JSON.parse(readFileSync(lbPath, "utf-8"));
    }
  }
  return merged;
}

export const f125Routes = new Hono()

  // GET /api/f1-25/sources — list setup sources
  .get("/api/f1-25/sources", (c) => {
    return c.json(getSourceDirs().map(({ meta }) => meta));
  })

  // GET /api/f1-25/tracks — list all tracks with setup counts
  .get("/api/f1-25/tracks",
    (c) => {
      if (!existsSync(F125_TUNES_DIR)) return c.json([]);
      const trackFiles = readdirSync(F125_TUNES_DIR).filter((f) => f.endsWith(".json"));
      const summary = [];
      for (const file of trackFiles) {
        try {
          const data = JSON.parse(readFileSync(resolve(F125_TUNES_DIR, file), "utf-8"));
          if (!data.trackSlug) continue;
          const setups = loadSetupsByTrack(data.trackSlug);
          const meta = loadTrackMeta(data.trackSlug);
          summary.push({
            trackSlug: data.trackSlug,
            trackName: data.trackName,
            trackOrdinal: data.trackOrdinal,
            setupCount: setups.length,
            videoUrl: meta.videoUrl ?? "",
            guideUrl: meta.guideUrl ?? "",
          });
        } catch {}
      }
      return c.json(summary);
    }
  )

  // GET /api/f1-25/setups?track=spa — get setups + track meta
  .get("/api/f1-25/setups",
    zValidator("query", z.object({ track: z.string().optional() })),
    (c) => {
      const { track } = c.req.valid("query");
      if (track) {
        const identity = loadTrackIdentity(track);
        if (!identity) return c.json({ error: "Track not found" }, 404);
        const meta = loadTrackMeta(track);
        const setups = loadSetupsByTrack(track);
        return c.json({ ...identity, ...meta, setups });
      }
      // Return all tracks with setups
      if (!existsSync(F125_TUNES_DIR)) return c.json([]);
      const trackFiles = readdirSync(F125_TUNES_DIR).filter((f) => f.endsWith(".json"));
      const all = [];
      for (const file of trackFiles) {
        try {
          const identity = JSON.parse(readFileSync(resolve(F125_TUNES_DIR, file), "utf-8"));
          if (!identity.trackSlug) continue;
          const meta = loadTrackMeta(identity.trackSlug);
          const setups = loadSetupsByTrack(identity.trackSlug);
          all.push({ ...identity, ...meta, setups });
        } catch {}
      }
      return c.json(all);
    }
  );
