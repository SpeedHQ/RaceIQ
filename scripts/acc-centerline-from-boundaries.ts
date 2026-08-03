/**
 * Rebuilds ACC centerline CSVs as the true track centre.
 *
 * ACC's `-centerline.csv` was historically fastlane.ai's racing line — it apexes
 * and cuts, so corner detection cannot find corners it straightens away. The true
 * centre is the midpoint of the committed leftEdge/rightEdge, so this needs no
 * game files and is reproducible from the repo alone.
 *
 * The racing line is preserved as `-raceline.csv` (it is a genuine reference line
 * for coaching, just not a centreline).
 *
 * Migration is per-track: the curated name lists in shared/data/tracks/meta/
 * were written against the racing line's segmentation, so the true centre — which
 * resolves corners the racing line had fused — only aligns writably on the tracks
 * in ADOPTED. The rest keep the racing line as their centerline until their name
 * list is re-curated against it (see issue #98).
 *
 * Usage: bun scripts/acc-centerline-from-boundaries.ts [--write] [slug...]
 *   --write        persist; otherwise dry-run
 *   slug...        restrict to these tracks (defaults to ADOPTED)
 *   --all-pending  also report shift stats for not-yet-adopted tracks
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ACC_DIR = join(import.meta.dir, "..", "shared", "data", "tracks", "acc");

type Point = { x: number; z: number };

function parseCsv(path: string): Point[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [x, z] = line.split(",");
      return { x: Number(x), z: Number(z) };
    });
}

function toCsv(points: Point[]): string {
  const lines = ["x,z"];
  for (const p of points) lines.push(`${p.x.toFixed(4)},${p.z.toFixed(4)}`);
  return lines.join("\n");
}

/** Tracks whose curated name list aligns against the true centre (cost < 1). */
const ADOPTED = [
  "catalunya",
  "imola",
  "mount-panorama",
  "spa",
  "spielberg",
  "watkins-glen",
];

const args = process.argv.slice(2);
const write = args.includes("--write");
const allPending = args.includes("--all-pending");
const only = args.filter((a) => !a.startsWith("--"));

const allSlugs = readdirSync(ACC_DIR)
  .filter((f) => f.endsWith("-boundaries.json"))
  .map((f) => f.replace("-boundaries.json", ""))
  .sort();

const target = only.length > 0 ? only : allPending ? allSlugs : ADOPTED;

for (const slug of allSlugs) {
  const boundariesPath = join(ACC_DIR, `${slug}-boundaries.json`);
  const centerlinePath = join(ACC_DIR, `${slug}-centerline.csv`);
  const racelinePath = join(ACC_DIR, `${slug}-raceline.csv`);

  const boundaries = JSON.parse(readFileSync(boundariesPath, "utf8")) as {
    leftEdge: Point[];
    rightEdge: Point[];
  };
  const { leftEdge, rightEdge } = boundaries;

  if (leftEdge.length !== rightEdge.length) {
    console.error(`[${slug}] edge length mismatch (${leftEdge.length} vs ${rightEdge.length}) — skipped`);
    continue;
  }

  // The racing line currently lives in -centerline.csv; preserve it once, before
  // the centerline is overwritten with the true centre.
  const raceline = existsSync(racelinePath) ? parseCsv(racelinePath) : parseCsv(centerlinePath);
  if (raceline.length !== leftEdge.length) {
    console.error(`[${slug}] index parity broken (${raceline.length} nodes vs ${leftEdge.length} edges) — skipped`);
    continue;
  }

  const centre = leftEdge.map((l, i) => ({
    x: (l.x + rightEdge[i].x) / 2,
    z: (l.z + rightEdge[i].z) / 2,
  }));

  const shifts = centre
    .map((c, i) => Math.hypot(c.x - raceline[i].x, c.z - raceline[i].z))
    .sort((a, b) => a - b);
  const median = shifts[Math.floor(shifts.length / 2)];
  const max = shifts[shifts.length - 1];

  // -centerline.csv is fully derived: the true centre for ADOPTED tracks, and the
  // racing line for those still pending re-curation. -raceline.csv always holds the
  // racing line — it is the reference line the analyse view renders.
  const adopt = target.includes(slug);
  if (write) {
    writeFileSync(racelinePath, toCsv(raceline));
    writeFileSync(centerlinePath, toCsv(adopt ? centre : raceline));
  }

  console.log(
    `[${slug}] ${centre.length} pts — shift median ${median.toFixed(1)}m / max ${max.toFixed(1)}m` +
      (adopt ? `${write ? " → centre written" : " → would adopt"}` : " — pending re-curation, keeping racing line"),
  );
}
