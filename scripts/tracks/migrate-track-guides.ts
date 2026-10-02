/**
 * ONE-SHOT migration tool — delete once shared/data/tracks/guides/*.json is committed.
 *
 * Converts the inline `guides` array in server/ai/track-guides.ts into one JSON
 * file per layout.
 *
 * Guide *data* is read from the live module, never regexed out of the source:
 * the fragility of parsing that 1000-line literal is exactly what this
 * migration exists to delete, and a regex would inherit it. Only the
 * surrounding *comments* are read from the text, because they don't survive
 * into the runtime object — `// Sources:` becomes the `sources` field and the
 * remaining prose becomes `notes`, both hand-reviewed afterwards.
 *
 * Requires a working-tree-only edit to server/ai/track-guides.ts:
 *
 *   export const __rawGuides = guides;
 *
 * Usage: bun scripts/tracks/migrate-track-guides.ts   (then revert that export)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrackGuideCornerFile, TrackGuideFile } from "../../shared/racing/tracks/guide/types";
// @ts-expect-error — __rawGuides is a temporary export that exists only while this script runs.
import { __rawGuides } from "../../server/ai/track-guides";

interface RawCorner {
  name: string;
  numbers?: number[];
  type: string;
  technique: string;
  trap: string;
}
interface RawGuide {
  id: string;
  character: string;
  corners: RawCorner[];
  priorityCorners: string[];
}

const SOURCE = resolve(import.meta.dir, "..", "..", "server", "ai", "track-guides.ts");
const OUT_DIR = resolve(import.meta.dir, "..", "..", "shared", "data", "tracks", "guides");

/**
 * Stable key from the English name: NFD accent-strip so `Courbe Paul Frère`
 * and `Courbe Paul Frere` can't produce different keys, then everything
 * non-alphanumeric collapses to a single dash.
 */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pull each guide's surrounding comments out of the source text.
 *
 * The array is uniformly formatted — every guide is exactly one `^  {` … `^  },`
 * block — so blocks are found by those markers rather than by brace counting.
 * Comments before a block are its preamble; comments inside it are per-corner
 * asides that have nowhere else to go.
 */
function extractComments(): Map<string, { sources?: string; notes?: string }> {
  const lines = readFileSync(SOURCE, "utf-8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("const guides"));
  const end = lines.findIndex((l, i) => i > start && l === "];");
  const out = new Map<string, { sources?: string; notes?: string }>();

  let preamble: string[] = [];
  let block: string[] | null = null;
  let inner: string[] = [];
  let id: string | null = null;

  const commentText = (l: string) => l.trim().replace(/^\/\/\s?/, "").trim();

  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (line === "  {") {
      block = [];
      inner = [];
      id = null;
      continue;
    }
    if (line === "  },") {
      if (id) out.set(id, splitPreamble(preamble, inner));
      preamble = [];
      block = null;
      continue;
    }
    if (block === null) {
      // Between guides: a ─── header line, or the next guide's Sources block.
      if (line.trim().startsWith("//")) preamble.push(commentText(line));
      continue;
    }
    const m = line.match(/^\s*id:\s*"([^"]+)"/);
    if (m) id = m[1]!;
    if (line.trim().startsWith("//")) inner.push(commentText(line));
  }
  return out;
}

/**
 * A preamble is: an optional `─── Track Name ───` banner (dropped — the
 * filename says it), a `Sources:` paragraph, and sometimes a blank-line-
 * separated caveat paragraph. Only the Sources paragraph is `sources`;
 * everything else, plus any in-block asides, is `notes`.
 */
function splitPreamble(preamble: string[], inner: string[]): { sources?: string; notes?: string } {
  const notes: string[] = [];
  const sources: string[] = [];
  let mode: "none" | "sources" = "none";

  for (const raw of preamble) {
    const line = raw.replace(/^─+\s*|\s*─+$/g, "").trim();
    if (/^─/.test(raw) && !line) continue;
    if (/^[─\s]*$/.test(raw)) {
      mode = "none"; // blank comment line ends the Sources paragraph
      continue;
    }
    if (raw.startsWith("─") || (raw.endsWith("───") && !raw.includes(":"))) continue; // banner
    if (/^Sources:/i.test(raw)) {
      mode = "sources";
      sources.push(raw.replace(/^Sources:\s*/i, ""));
      continue;
    }
    (mode === "sources" ? sources : notes).push(raw);
  }
  notes.push(...inner);

  const join = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();
  const result: { sources?: string; notes?: string } = {};
  if (sources.length) result.sources = join(sources);
  if (notes.length) result.notes = join(notes);
  return result;
}

/** Serialise with the field order the schema documents, corners one per line. */
function render(guide: TrackGuideFile): string {
  const corner = (c: TrackGuideCornerFile) => {
    const fields: string[] = [`"key": ${JSON.stringify(c.key)}`, `"name": ${JSON.stringify(c.name)}`];
    if (c.numbers) fields.push(`"numbers": [${c.numbers.join(", ")}]`);
    for (const f of ["type", "technique", "trap"] as const) fields.push(`"${f}": ${JSON.stringify(c[f])}`);
    return `    {\n      ${fields.join(",\n      ")}\n    }`;
  };
  const head: string[] = [
    `  "id": ${JSON.stringify(guide.id)}`,
    `  "locale": "en"`,
    `  "character": ${JSON.stringify(guide.character)}`,
  ];
  if (guide.sources) head.push(`  "sources": ${JSON.stringify(guide.sources)}`);
  if (guide.notes) head.push(`  "notes": ${JSON.stringify(guide.notes)}`);
  head.push(`  "corners": [\n${guide.corners.map(corner).join(",\n")}\n  ]`);
  head.push(`  "priorityCorners": ${JSON.stringify(guide.priorityCorners)}`);
  return `{\n${head.join(",\n")}\n}\n`;
}

const comments = extractComments();
const guides = __rawGuides as RawGuide[];
mkdirSync(OUT_DIR, { recursive: true });

let unresolved = 0;
for (const g of guides) {
  const keys = new Map<string, number>();
  const corners: TrackGuideCornerFile[] = g.corners.map((c) => {
    let key = slugify(c.name);
    const n = (keys.get(key) ?? 0) + 1;
    keys.set(key, n);
    if (n > 1) {
      // Two corners sharing an English name: keep both keys stable and distinct.
      console.warn(`${g.id}: duplicate name ${JSON.stringify(c.name)} → ${key}-${n}`);
      key = `${key}-${n}`;
    }
    return { key, name: c.name, ...(c.numbers ? { numbers: c.numbers } : {}), type: c.type, technique: c.technique, trap: c.trap };
  });

  const byName = new Map(g.corners.map((c, i) => [c.name, corners[i]!.key]));
  const priorityCorners = g.priorityCorners.map((p) => {
    const key = byName.get(p);
    if (!key) {
      // Pre-existing dangling reference: the old code silently matched nothing.
      console.warn(`${g.id}: priorityCorners entry ${JSON.stringify(p)} matches no corner — dropped`);
      unresolved++;
      return null;
    }
    return key;
  }).filter((k): k is string => k !== null);

  const meta = comments.get(g.id) ?? {};
  const file: TrackGuideFile = {
    id: g.id,
    locale: "en",
    character: g.character,
    ...(meta.sources ? { sources: meta.sources } : {}),
    ...(meta.notes ? { notes: meta.notes } : {}),
    corners,
    priorityCorners,
  };
  writeFileSync(resolve(OUT_DIR, `${g.id}.json`), render(file));
}

console.log(`Wrote ${guides.length} guides → ${OUT_DIR}`);
if (unresolved) console.log(`⚠ ${unresolved} unresolved priorityCorners entries (see warnings above)`);
