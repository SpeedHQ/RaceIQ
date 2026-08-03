/**
 * Curation coverage: how many of each game's tracks carry a hand-authored
 * corner roster (`shared/data/tracks/meta/<slug>.json` with a non-empty `corners`
 * array), out of every track that game ships a centerline for.
 *
 * This is the "how much real curation exists" number, NOT "how many tracks have
 * a segments file" — the fallback detector writes geometry for essentially every
 * centerline, so counting geometry files would always read ~100% and measure
 * nothing. See CLAUDE.md → "Track Segments: curated geometry is the source of
 * truth".
 *
 * The rendered table is committed in CLAUDE.md and asserted by
 * test/track-coverage.test.ts, so curating a track forces the stat to be
 * refreshed (`bun run tracks:coverage --write`).
 */

import { listAllCenterlines, listCuratedSlugs } from "./generate";
import { loadVerified, verifyState, type VerifyState } from "./verified";
import type { GameId } from "@shared/games/ids";

/** Human label per game. Adding a game to `GameId` breaks this on purpose. */
const GAME_LABELS: Record<GameId, string> = {
  "fm-2023": "Forza Motorsport (fm-2023)",
  "f1-2025": "F1 25 (f1-2025)",
  acc: "ACC (acc)",
  "ac-evo": "AC Evo (ac-evo)",
  iracing: "iRacing (iracing)",
};

/** Order rows are rendered in — stable output so the committed table diffs cleanly. */
// iRacing exposes lap distance but not a stable world-space centerline through
// its live SDK, so it does not participate in centerline-curation coverage.
const GAME_ORDER: GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo"];

/**
 * Centerline basename → track slug.
 *
 * Forza embeds the in-game track ordinal in the filename
 * (`brands-hatch-860-centerline.csv`), and that ordinal is not part of the slug
 * the meta roster is keyed by. Every other game names the file after the slug.
 */
export function canonicalSlug(gameId: GameId, centerlineSlug: string): string {
  return gameId === "fm-2023" ? centerlineSlug.replace(/-\d+$/, "") : centerlineSlug;
}

/** One track's state within one game — the per-track detail behind a `CoverageRow`. */
export interface TrackCoverage {
  slug: string;
  /** Hand-authored roster exists (`meta/<slug>.json` with corners). Shared across games. */
  curated: boolean;
  /** Signature state of the shared roster. */
  meta: VerifyState;
  /** Signature state of *this game's* geometry file. */
  segments: VerifyState;
}

export interface CoverageRow {
  gameId: GameId;
  label: string;
  curated: number;
  total: number;
  /** Slugs this game ships that have no hand-authored roster, sorted. */
  uncurated: string[];
  /** Roster (`meta/<slug>.json`) signed off by a human and unchanged since. */
  metaVerified: number;
  /** Roster signed off but edited since — signature no longer counts. */
  metaStale: number;
  /** Per-game geometry (`<slug>-segments.json`) signed off and unchanged since. */
  segmentsVerified: number;
  /** Geometry signed off but regenerated since — signature no longer counts. */
  segmentsStale: number;
  /** Every slug this game ships, sorted — the rows of the per-game detail table. */
  tracks: TrackCoverage[];
}

/** Per-game curated-roster coverage, in `GAME_ORDER`. */
export function curatedCoverage(): CoverageRow[] {
  const curated = new Set(listCuratedSlugs());
  const perGame = new Map<GameId, Set<string>>();
  for (const c of listAllCenterlines()) {
    const slug = canonicalSlug(c.gameId, c.slug);
    let set = perGame.get(c.gameId);
    if (!set) perGame.set(c.gameId, (set = new Set()));
    set.add(slug);
  }

  const ledger = loadVerified();
  const rows: CoverageRow[] = [];
  for (const gameId of GAME_ORDER) {
    const slugs = [...(perGame.get(gameId) ?? [])].sort();
    if (slugs.length === 0) continue;
    const uncurated = slugs.filter((s) => !curated.has(s));
    const count = (kind: "meta" | "segments", want: string) =>
      slugs.filter((s) => verifyState(ledger, kind, s, gameId) === want).length;
    rows.push({
      gameId,
      label: GAME_LABELS[gameId],
      curated: slugs.length - uncurated.length,
      total: slugs.length,
      uncurated,
      metaVerified: count("meta", "verified"),
      metaStale: count("meta", "stale"),
      segmentsVerified: count("segments", "verified"),
      segmentsStale: count("segments", "stale"),
      tracks: slugs.map((slug) => ({
        slug,
        curated: curated.has(slug),
        meta: verifyState(ledger, "meta", slug, gameId),
        segments: verifyState(ledger, "segments", slug, gameId),
      })),
    });
  }
  return rows;
}

/** `12/24 (50%)`, with a stale-signature suffix when there is one. */
function cell(n: number, total: number, stale = 0): string {
  const pct = total === 0 ? 0 : Math.round((n / total) * 100);
  return `${n}/${total} (${pct}%)${stale > 0 ? ` +${stale} stale` : ""}`;
}

/** Markdown table body committed into CLAUDE.md between the coverage markers. */
export function renderCoverageTable(rows: CoverageRow[] = curatedCoverage()): string {
  const lines = [
    "| Game | Tracks | Curated roster | Meta human-verified | Segments human-verified | Not yet curated |",
    "|------|--------|----------------|---------------------|-------------------------|-----------------|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${r.total} | ${cell(r.curated, r.total)} | ${cell(r.metaVerified, r.total, r.metaStale)} | ` +
        `${cell(r.segmentsVerified, r.total, r.segmentsStale)} | ${r.uncurated.join(", ") || "—"} |`,
    );
  }
  const sum = (pick: (r: CoverageRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const total = sum((r) => r.total);
  lines.push(
    `| **Total** | **${total}** | **${cell(sum((r) => r.curated), total)}** | ` +
      `**${cell(sum((r) => r.metaVerified), total, sum((r) => r.metaStale))}** | ` +
      `**${cell(sum((r) => r.segmentsVerified), total, sum((r) => r.segmentsStale))}** | |`,
  );
  return lines.join("\n");
}

/** Cell glyph for a signature state. */
function mark(state: VerifyState): string {
  return state === "verified" ? "✅" : state === "stale" ? "⚠️ stale" : "—";
}

/**
 * Per-game, per-track detail — one table per game, committed into
 * docs/contributing/track-curation.md between the detail markers.
 *
 * Geometry is per game because each title digitises its own centerline: the
 * same circuit's corners land at different distances (and sometimes a different
 * corner count) per game, so a roster can be shared while geometry cannot. That
 * is why the Segments column is signed off per game and Meta is not.
 */
export function renderDetailTables(rows: CoverageRow[] = curatedCoverage()): string {
  const out: string[] = [];
  for (const r of rows) {
    out.push(
      `#### ${r.label}`,
      "",
      `${cell(r.curated, r.total)} curated · ${cell(r.metaVerified, r.total, r.metaStale)} meta-verified · ` +
        `${cell(r.segmentsVerified, r.total, r.segmentsStale)} segments-verified`,
      "",
      "| Track | Curated roster | Meta verified | Segments verified |",
      "|-------|----------------|---------------|-------------------|",
    );
    for (const t of r.tracks) {
      out.push(`| ${t.slug} | ${t.curated ? "✅" : "—"} | ${mark(t.meta)} | ${mark(t.segments)} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}
