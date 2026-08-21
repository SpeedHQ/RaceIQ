/**
 * Extract native AC Evo track geometry (centerlines + boundaries) from
 * `content.kspkg`'s `.ideal_line.aisplinedata` protobuf spline files, and
 * generate curated meta (segments/sectors) for any AC Evo track that
 * doesn't already have one.
 *
 * Native geometry is written to each canonical AC Evo layout. Five layouts
 * without an `ideal_line` (Misano, Silverstone, Catalunya, Budapest, Zandvoort)
 * explicitly reuse their root-venue ACC assets; every other mapped layout must
 * have its own extracted geometry.
 *
 * Run: bun scripts/games/ac-evo/extract-track-geometry.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findContentKspkg, Kspkg, type KspkgEntry } from "../../../server/games/ac-evo/kspkg";
import { parseAiSpline, type AiSplinePoint } from "../../../server/games/ac-evo/aispline";
import { autoTrackSegments } from "../../../shared/racing/tracks/curation/generate";
import { splitSegments } from "../../../shared/racing/tracks/curation/join";
import { loadTrackFacts, loadTrackGeometryForGame, saveTrackFacts, saveTrackGeometry, saveTrackMetadata } from "../../../shared/racing/tracks/storage/meta";
import { GAMES_DIR } from "../../../shared/platform/runtime/data-paths";
import {
  bundledGeometryPath,
  bundledSharedAccGeometryPath,
  findTrackAssetIdentities,
  getTrackAssetIdentity,
  isSharedAccGeometryAsset,
  type TrackAssetIdentity,
} from "../../../shared/racing/tracks/storage/assets";

interface TrackRow {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
  setupFolder: string;
}

/** Ground-truth folder + ideal-line layout per AC Evo track slug (see task brief). */
interface Mapping {
  slug: string;
  folder: string;
  layout: string;
}

const MAPPINGS: Mapping[] = [
  { slug: "monza", folder: "monza", layout: "layout_gp" },
  { slug: "nurburgring", folder: "nurburgring", layout: "layout_gp_strecke" },
  { slug: "brands-hatch", folder: "brands_hatch", layout: "layout_gp" },
  { slug: "mount-panorama", folder: "mount_panorama", layout: "track_layout" },
  { slug: "spa", folder: "spa", layout: "layout_gp" },
  { slug: "imola", folder: "imola", layout: "layout_imola" },
  { slug: "paul-ricard", folder: "paul_ricard", layout: "layout_1a_v2" },
  { slug: "laguna-seca", folder: "laguna_seca", layout: "layout_laguna_seca" },
  { slug: "nordschleife", folder: "nurburgring", layout: "layout_24h" },
  { slug: "suzuka", folder: "suzuka", layout: "layout_gp" },
  { slug: "kyalami", folder: "kyalami", layout: "layout_gp" },
  { slug: "spielberg", folder: "redbull_ring", layout: "layout_gp" },
  { slug: "brands-hatch-indy", folder: "brands_hatch", layout: "layout_indy" },
  { slug: "fuji", folder: "fuji", layout: "layout_gp_circuit" },
  { slug: "oulton-park", folder: "oulton_park", layout: "layout_international" },
  { slug: "road-atlanta", folder: "road_atlanta", layout: "layout_gp" },
  { slug: "sebring", folder: "sebring", layout: "layout_gp" },
  { slug: "watkins-glen", folder: "watkins_glen", layout: "layout_gp" },
  { slug: "cota", folder: "cota", layout: "layout_gp" },
  { slug: "donington", folder: "donington", layout: "layout_grand_prix" },
];

/** Tracks with no ideal-line geometry in the kspkg — must keep the ACC fallback. */
const SKIP_SLUGS = new Set(["misano", "silverstone", "catalunya", "budapest", "zandvoort"]);

/** Known real-world lengths (m) for the 3 tracks ACC never shipped — hard sanity check. */
const CRITICAL_EXPECTED_M: Record<string, number> = {
  "brands-hatch-indy": 1929,
  fuji: 4563,
  cota: 5513,
};

function accCenterlinePath(slug: string): string | null {
  const identity = findTrackAssetIdentities(slug, "acc")[0];
  if (!identity) return null;
  return isSharedAccGeometryAsset(identity) ? bundledSharedAccGeometryPath(identity, slug, "centerline") : bundledGeometryPath(identity, "centerline");
}

function readTracksCsv(): TrackRow[] {
  const raw = readFileSync(resolve(GAMES_DIR, "ac-evo", "tracks.csv"), "utf-8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(1).map((l) => {
    const [id, name, variant, commonTrackName, setupFolder] = l.split(",");
    return { id: parseInt(id, 10), name, variant, commonTrackName, setupFolder };
  });
}

function polylineLength(pts: { x: number; z: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

function accLengthForSlug(slug: string): number | null {
  const path = accCenterlinePath(slug);
  if (!path || !existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const pts = lines.slice(1).map((l) => {
    const [x, z] = l.split(",").map(Number);
    return { x, z };
  });
  return pts.length > 10 ? polylineLength(pts) : null;
}

/** Find the ideal_line entry for folder+layout, preferring `layouts\` over `content\layouts\`. */
function findIdealLineEntry(entries: KspkgEntry[], folder: string, layout: string): KspkgEntry | null {
  const suffix = `\\${folder}\\layouts\\${layout}.ideal_line.aisplinedata`.toLowerCase();
  const altSuffix = `\\${folder}\\content\\layouts\\${layout}.ideal_line.aisplinedata`.toLowerCase();
  let primary: KspkgEntry | null = null;
  let fallback: KspkgEntry | null = null;
  for (const e of entries) {
    const p = e.path.toLowerCase();
    if (p.endsWith(suffix)) primary = e;
    else if (p.endsWith(altSuffix)) fallback = e;
  }
  return primary ?? fallback;
}

/** Perpendicular offset boundary from a centerline, using local tangent/normal. Nominal half-width fallback. */
function computeBoundaries(
  centerline: { x: number; z: number }[],
  halfWidthM = 6,
): {
  leftEdge: { x: number; z: number }[];
  rightEdge: { x: number; z: number }[];
} {
  const n = centerline.length;
  const leftEdge: { x: number; z: number }[] = [];
  const rightEdge: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = centerline[(i - 1 + n) % n];
    const next = centerline[(i + 1) % n];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tlen = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tlen;
    tz /= tlen;
    // Normal = perpendicular to tangent (rotate 90deg)
    const nx = -tz;
    const nz = tx;
    const p = centerline[i];
    leftEdge.push({ x: p.x + nx * halfWidthM, z: p.z + nz * halfWidthM });
    rightEdge.push({ x: p.x - nx * halfWidthM, z: p.z - nz * halfWidthM });
  }
  return { leftEdge, rightEdge };
}

function writeCenterlineCsv(identity: TrackAssetIdentity, pts: AiSplinePoint[]): void {
  const path = bundledGeometryPath(identity, "centerline");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `x,z\n${pts.map((p) => `${p.x},${p.z}`).join("\n")}`);
}

/** The ideal_line spline IS the game's AI racing line, so also emit it to the
 *  raceline slot that getTrackRacelineByOrdinal() reads. AC Evo ships no
 *  separate dense centerline spline, so centerline and raceline share this
 *  source until a true centerline becomes available. */
function writeRacelineCsv(identity: TrackAssetIdentity, pts: AiSplinePoint[]): void {
  writeFileSync(bundledGeometryPath(identity, "raceline"), `x,z\n${pts.map((p) => `${p.x},${p.z}`).join("\n")}`);
}

function writeBoundariesJson(identity: TrackAssetIdentity, centerline: { x: number; z: number }[]): void {
  const { leftEdge, rightEdge } = computeBoundaries(centerline);
  const data = {
    source: "ac-evo-extracted",
    // Raw kspkg coords, but flag pre-aligned so loadExtractedBoundary() skips
    // its Procrustes fit (that fit is for ACC boundary files borrowed by AC Evo
    // and distorts native data). Frame correction is the render-time
    // needsTrackFlip() mirror, same as ACC — not a server-side transform.
    aligned: true,
    nodeCount: centerline.length,
    leftEdge,
    rightEdge,
  };
  writeFileSync(bundledGeometryPath(identity, "boundaries"), JSON.stringify(data, null, 2));
}

/**
 * Seed a newly extracted layout's facts and this game's geometry, never
 * clobbering either if it is already there.
 *
 * Missing halves are seeded independently. When both are absent, facts and
 * native AC Evo geometry are committed together so source validation observes
 * one complete update.
 *
 * `autoTrackSegments` emits `T<n>` tokens for corners it has no name for.
 * `splitSegments` drops those — a generated token is a display convention, not
 * a fact — so a seeded layout starts with unnamed corners waiting on curation.
 */
function maybeWriteMeta(slug: string, name: string, centerline: { x: number; z: number }[]): "written" | "geometry-only" | "skipped-existing" | "skipped-no-corners" {
  const existingFacts = loadTrackFacts(slug);
  const existingGeometry = loadTrackGeometryForGame(slug, "ac-evo");
  if (existingFacts && existingGeometry) return "skipped-existing";

  const result = autoTrackSegments(centerline);
  if (result.segments.length === 0) return "skipped-no-corners";
  const { corners, straights, geometry } = splitSegments(result.segments);
  const nativeGeometry = {
    sectors: { s1End: 1 / 3, s2End: 2 / 3 },
    segments: geometry,
  };

  if (existingFacts) {
    saveTrackGeometry(slug, "ac-evo", nativeGeometry);
    return "geometry-only";
  }

  // New content lands in tracks.csv as variant GP (the game's table carries no
  // layout list), so the identity matches until an alt layout is added by hand.
  const facts = {
    slug,
    track: slug,
    layout: "gp",
    layoutName: "Grand Prix",
    name,
    corners,
    ...(straights.length ? { straights } : {}),
  };
  if (existingGeometry) saveTrackFacts(slug, facts);
  else saveTrackMetadata(slug, facts, { "ac-evo": nativeGeometry });
  return "written";
}

export async function extractAcEvoTrackGeometry() {
  const kspkgPath = findContentKspkg();
  if (!kspkgPath) {
    console.error("content.kspkg not found — cannot extract AC Evo track geometry.");
    process.exit(1);
  }
  console.log(`Using kspkg: ${kspkgPath}`);
  const pkg = Kspkg.open(kspkgPath);

  const tracksCsv = readTracksCsv();
  const tracksBySlug = new Map(tracksCsv.map((track) => [track.commonTrackName, track]));

  interface Row {
    slug: string;
    folder: string;
    layout: string;
    points: number;
    lengthM: number;
    expectedM: number | null;
    deltaPct: number | null;
    status: string;
    metaStatus: string;
  }
  const rows: Row[] = [];

  for (const m of MAPPINGS) {
    const track = tracksBySlug.get(m.slug);
    const identity = track && getTrackAssetIdentity("ac-evo", track.id);
    if (!track || !identity) {
      console.warn(`[skip] ${m.slug}: no canonical AC Evo registry assignment`);
      continue;
    }
    const entry = findIdealLineEntry(pkg.entries, m.folder, m.layout);
    if (!entry) {
      console.warn(`[skip] ${m.slug}: no ideal_line entry found for ${m.folder}/${m.layout}`);
      continue;
    }
    const buf = pkg.readFile(entry);
    let points: AiSplinePoint[];
    try {
      points = parseAiSpline(buf);
    } catch (err) {
      console.error(`[fail] ${m.slug}: failed to parse aisplinedata — ${(err as Error).message}`);
      continue;
    }
    if (points.length < 20) {
      console.warn(`[skip] ${m.slug}: only ${points.length} points, too sparse`);
      continue;
    }

    // Output stays in RAW kspkg world coords — identical convention to ACC's
    // bundled files (see track-coords.ts): outline/boundary data is raw, and the
    // renderers flip it via needsTrackFlip() to match the pipeline-negated
    // telemetry (AC Evo coordSystem "standard-xyz"). Pre-negating here would
    // double-flip on the analyse map. The kspkg↔telemetry relation is X-mirror:
    // verified on Brands Hatch Indy, negating X drops telemetry↔spline mean
    // nearest distance ~68 m → ~10 m; the render flip applies exactly that.
    const centerline = points.map((p) => ({ x: p.x, z: p.z }));
    // Corner left/right in the meta must read from the driver's view, so derive
    // segments from the display-frame (X-negated) copy. Arc-length fractions are
    // mirror-invariant, so only the direction labels differ from raw.
    const displayCenterline = centerline.map((p) => ({ x: -p.x, z: p.z }));
    const lengthM = polylineLength(centerline);
    const expectedM = CRITICAL_EXPECTED_M[m.slug] ?? accLengthForSlug(m.slug);
    const deltaPct = expectedM ? ((lengthM - expectedM) / expectedM) * 100 : null;
    const status = deltaPct === null ? "no-reference" : Math.abs(deltaPct) <= 5 ? "OK" : "CHECK";

    writeCenterlineCsv(identity, points);
    writeRacelineCsv(identity, points);
    writeBoundariesJson(identity, centerline);

    const displayName = track.name + (track.variant !== "GP" ? ` ${track.variant}` : "");
    const metaStatus = maybeWriteMeta(m.slug, displayName, displayCenterline);

    rows.push({
      slug: m.slug,
      folder: m.folder,
      layout: m.layout,
      points: points.length,
      lengthM,
      expectedM,
      deltaPct,
      status,
      metaStatus,
    });
  }

  pkg.close();

  console.log("\n=== Extraction validation ===");
  console.log(`${"slug".padEnd(20) + "pts".padStart(6) + "length(m)".padStart(12) + "expected(m)".padStart(13) + "delta%".padStart(9)}  status  metaStatus`);
  for (const r of rows) {
    console.log(
      r.slug.padEnd(20) +
        String(r.points).padStart(6) +
        r.lengthM.toFixed(1).padStart(12) +
        (r.expectedM ? r.expectedM.toFixed(1) : "-").padStart(13) +
        (r.deltaPct !== null ? r.deltaPct.toFixed(2) : "-").padStart(9) +
        `  ${r.status.padEnd(7)} ${r.metaStatus}`,
    );
  }

  console.log("\n=== Critical tracks (previously missing entirely) ===");
  for (const slug of ["brands-hatch-indy", "fuji", "cota"]) {
    const r = rows.find((x) => x.slug === slug);
    if (!r) {
      console.log(`${slug}: NOT EXTRACTED`);
      continue;
    }
    console.log(`${slug}: ${r.lengthM.toFixed(1)}m (expected ~${r.expectedM}m, delta ${r.deltaPct?.toFixed(2)}%) — ${r.status}`);
  }

  console.log(`\nSkipped (no ideal_line in kspkg, keep ACC fallback): ${[...SKIP_SLUGS].join(", ")}`);
  console.log(`\nWrote centerline/boundaries for ${rows.length} tracks to canonical venue geometry`);
}

// Runnable standalone (bun scripts/games/ac-evo/extract-track-geometry.ts) as well as
// imported by extract-tracks.ts. import.meta.main is Bun-native (no dynamic import).
if (import.meta.main) extractAcEvoTrackGeometry();
