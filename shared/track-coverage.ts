/**
 * Curation coverage: how many of each game's tracks carry a hand-authored
 * corner roster (`shared/tracks/meta/<slug>.json` with a non-empty `corners`
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

import { listAllCenterlines, listCuratedSlugs } from "./track-segment-generate";
import { loadVerified, verifyState } from "./track-verified";
import type { GameId } from "./types";

/** Human label per game. Adding a game to `GameId` breaks this on purpose. */
const GAME_LABELS: Record<GameId, string> = {
  "fm-2023": "Forza Motorsport (fm-2023)",
  "f1-2025": "F1 25 (f1-2025)",
  acc: "ACC (acc)",
  "ac-evo": "AC Evo (ac-evo)",
};

/** Order rows are rendered in — stable output so the committed table diffs cleanly. */
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
