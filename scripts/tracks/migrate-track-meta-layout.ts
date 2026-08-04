import type { NamedSegment as LegacyNamedSegment } from "../../shared/racing/tracks/named-segments";
import type { CornerFact, StraightFact, TrackFacts } from "../../shared/racing/tracks/facts";
import type { TrackGeometry } from "../../shared/racing/tracks/geometry";
import type { LegacyMeta } from "./migrate-track-meta-input";
import { keySegments, vote, voteDirection, type KeyedRow } from "./migrate-track-meta-segments";
import type { LayoutIdentity } from "./migrate-track-meta-identity";

const DIRECTION_OVERRIDES: Record<string, Record<string, "left" | "right">> = {
  // Eau Rouge is the uphill left-hand flick at the bottom of the hill; the
  // right that follows is Raidillon. f1-2025 has it left, ac-evo mirrored.
  spa: { t3: "left" },
};

export interface Conflict {
  slug: string;
  key: string;
  field: string;
  values: string[];
}

export function buildLayout(
  slug: string,
  meta: LegacyMeta,
  blocks: Record<string, { sectors?: LegacyMeta["sectors"]; segments: LegacyNamedSegment[] }>,
  identity: LayoutIdentity,
): { facts: TrackFacts; geometry: Record<string, TrackGeometry>; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const keyed: Record<string, KeyedRow[]> = {};
  for (const [gameId, block] of Object.entries(blocks)) keyed[gameId] = keySegments(block.segments);

  const cornerRows = new Map<string, LegacyNamedSegment[]>();
  for (const rows of Object.values(keyed)) {
    for (const row of rows) {
      if (!row.key.startsWith("t")) continue;
      if (!cornerRows.has(row.key)) cornerRows.set(row.key, []);
      cornerRows.get(row.key)!.push(row.legacy);
    }
  }

  const corners: CornerFact[] = [];
  for (const [key, rows] of cornerRows) {
    const numbers = key.slice(1).split("-").map((part) => Number.parseInt(part, 10));
    const nameVote = vote(rows.map((row) => row.name ?? ""), true);
    const override = DIRECTION_OVERRIDES[slug]?.[key];
    const dirVote = override ? { value: override, conflict: null } : voteDirection(rows);
    const groupVote = vote(rows.map((row) => row.group ?? ""), false);
    if (nameVote.conflict) conflicts.push({ slug, key, field: "name", values: nameVote.conflict });
    if (dirVote.conflict) conflicts.push({ slug, key, field: "direction", values: dirVote.conflict });
    if (groupVote.conflict) conflicts.push({ slug, key, field: "group", values: groupVote.conflict });

    corners.push({
      number: numbers[0],
      ...(numbers.length > 1 ? { covers: numbers.slice(1) } : {}),
      name: nameVote.value,
      ...(dirVote.value ? { direction: dirVote.value as "left" | "right" } : {}),
      ...(groupVote.value ? { group: groupVote.value } : {}),
    });
  }
  corners.sort((a, b) => a.number - b.number);

  const straightRows = new Map<number, LegacyNamedSegment[]>();
  for (const rows of Object.values(keyed)) {
    for (const row of rows) {
      if (row.key.startsWith("t") || row.key === "s?") continue;
      const after = Number.parseInt(row.key.slice(1), 10);
      if (!straightRows.has(after)) straightRows.set(after, []);
      straightRows.get(after)!.push(row.legacy);
    }
  }

  const straights: StraightFact[] = [];
  for (const [after, rows] of straightRows) {
    const nameVote = vote(rows.map((row) => row.name ?? ""), true);
    const groupVote = vote(rows.map((row) => row.group ?? ""), false);
    if (nameVote.conflict) conflicts.push({ slug, key: `s${after}`, field: "name", values: nameVote.conflict });
    if (!nameVote.value && !groupVote.value) continue;
    straights.push({ after, name: nameVote.value, ...(groupVote.value ? { group: groupVote.value } : {}) });
  }
  straights.sort((a, b) => a.after - b.after);

  const geometry: Record<string, TrackGeometry> = {};
  for (const [gameId, rows] of Object.entries(keyed)) {
    geometry[gameId] = {
      ...(blocks[gameId].sectors ? { sectors: blocks[gameId].sectors } : {}),
      segments: rows.map((row) => ({ key: row.key, startFrac: row.startFrac, endFrac: row.endFrac })),
    };
  }

  const facts: TrackFacts = {
    slug,
    ...identity,
    name: meta.name,
    corners,
    ...(straights.length ? { straights } : {}),
  };
  return { facts, geometry, conflicts };
}

const NAME_OVERRIDES: Record<string, string> = {
  "brands-hatch": "Brands Hatch",
  "fujimi-kaido": "Fujimi Kaido",
};

/** Normalize venue display names after all layouts have been built. */
export function applyVenueNames(all: TrackFacts[]): void {
  const byTrack: Record<string, TrackFacts[]> = {};
  for (const facts of all) (byTrack[facts.track] ??= []).push(facts);

  for (const [track, layouts] of Object.entries(byTrack)) {
    const base = layouts.find((layout) => layout.slug === track) ?? layouts.reduce((a, b) => (a.slug.length <= b.slug.length ? a : b));
    const cleaned = base.name
      .replace(/\s*[—–]\s*.*$/, "")
      .replace(/\s+-\s+.*$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    const venue = NAME_OVERRIDES[track] ?? cleaned ?? base.name;
    for (const layout of layouts) layout.name = venue || base.name;
  }
}
