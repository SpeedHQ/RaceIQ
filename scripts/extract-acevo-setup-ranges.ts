/**
 * Extract per-car setup ranges from AC Evo's content.kspkg.
 *
 * Source of truth: `content/cars/<ks_folder>/data/setup/*.carsetuplimits`
 * (protobuf). Verified layout (anchored via unit strings "N/m"/"Ns/m"/"PSI"/
 * "DEG"/"deg"/"mm" and cross-car diffs — see docs/per-car-setup-ranges-plan.md):
 *
 *   Each leaf setting message: { #1 f32 step, #2 f32 min, #3 f32 max,
 *                                #4 varint clickable?, #7 str unit }
 *   (#2 absent => min 0; empty bytes(0) => component not present on car)
 *
 *   Top-level groups:
 *     #1 mechanical: #1 x2 ARB-rate-like blocks (UNVERIFIED semantics — not
 *        emitted), #2 steer ratio, #3.#1 brake bias, #3.#2 brake power,
 *        #4 differential
 *     #2 x4 per-corner springs ("N/m"), #3 x4 dampers ("Ns/m"),
 *     #4 x4 per-corner tyre PSI + camber/toe ("DEG")
 *     #5 electronics (TC/ABS/map)
 *     #6 aero: #2 front ride height, #3 rear ride height,
 *              #4 front wing, #5 rear wing
 *     #7 fuel: #1 fuel load
 *
 * Only components with verified anchors are emitted; keys match the AC Evo
 * snapshot field names used by RULES["ac-evo"] in server/ai/tune-rules.ts.
 * ARBs are deliberately omitted until the #1.#1 block semantics are confirmed
 * against a live telemetry snapshot (values are N/m-scale, RULES uses clicks).
 *
 * Usage:
 *   bun run scripts/extract-acevo-setup-ranges.ts [--kspkg <path>] [--dump <carFolder>] [--list]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Kspkg, findContentKspkg, type KspkgEntry } from "../server/games/ac-evo/kspkg";
import { decodeProtoMessage, type ProtoField } from "../server/games/ac-evo/kspkg-tables";

const LIMITS_RE = /^content\/cars\/([^/]+)\/data\/setup\/([^/]+)\.carsetuplimits$/i;

/** Open content.kspkg and collect carFolder -> limits entries (some cars ship variants, e.g. ae86 tuned). */
function collectCars(kspkgPathArg?: string): { pkg: Kspkg; cars: Map<string, KspkgEntry[]> } {
  const kspkgPath = findContentKspkg(kspkgPathArg);
  if (!kspkgPath) {
    throw new Error("content.kspkg not found; pass --kspkg <path> or set AC_EVO_KSPKG");
  }
  console.error(`kspkg: ${kspkgPath}`);
  const pkg = Kspkg.open(kspkgPath);
  const cars = new Map<string, KspkgEntry[]>();
  for (const e of pkg.entries) {
    const m = e.path.replace(/\\/g, "/").match(LIMITS_RE);
    if (m && !e.isDirectory) {
      const list = cars.get(m[1]) ?? [];
      list.push(e);
      cars.set(m[1], list);
    }
  }
  console.error(`cars with carsetuplimits: ${cars.size}`);
  return { pkg, cars };
}

// ---- proto helpers -------------------------------------------------------

function f32(f: ProtoField): number {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(Number(f.value) >>> 0);
  return b.readFloatLE(0);
}

function nested(f: ProtoField): ProtoField[] | null {
  if (f.wire !== 2 || !f.bytes || f.bytes.length < 2) return null;
  try {
    return decodeProtoMessage(f.bytes);
  } catch {
    return null;
  }
}

function field(fs: ProtoField[], num: number): ProtoField | undefined {
  return fs.find((f) => f.num === num);
}
function fieldsOf(fs: ProtoField[], num: number): ProtoField[] {
  return fs.filter((f) => f.num === num);
}

type Range = { min: number; max: number; step?: number } | null;

/** Decode one leaf setting message: {#1 step, #2 min, #3 max}. */
function readRange(f: ProtoField | undefined): Range {
  if (!f || f.wire !== 2 || !f.bytes) return null;
  if (f.bytes.length === 0) return null; // bytes(0) => component absent
  const fs = nested(f);
  if (!fs) return null;
  const stepF = field(fs, 1);
  const minF = field(fs, 2);
  const maxF = field(fs, 3);
  if (!maxF || maxF.wire !== 5) return null;
  const min = minF && minF.wire === 5 ? f32(minF) : 0;
  const max = f32(maxF);
  const step = stepF && stepF.wire === 5 ? f32(stepF) : undefined;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { min: round(min), max: round(max), ...(step !== undefined ? { step: round(step) } : {}) };
}

// ---- dump mode -----------------------------------------------------------

function dumpTree(fields: ProtoField[], indent: string, depth: number): void {
  for (const f of fields) {
    const base = `${indent}#${f.num} wire=${f.wire}`;
    if (f.wire === 2 && f.bytes) {
      const ascii = f.bytes.toString("utf8");
      const printable = /^[\x20-\x7e]*$/.test(ascii) && ascii.length > 0;
      const kids = depth < 8 ? nested(f) : null;
      if (kids && kids.length > 0) {
        console.log(`${base} msg(${f.bytes.length}B)`);
        dumpTree(kids, indent + "  ", depth + 1);
      } else if (printable) {
        console.log(`${base} str "${ascii.slice(0, 80)}"`);
      } else {
        console.log(`${base} bytes(${f.bytes.length}) ${f.bytes.subarray(0, 16).toString("hex")}`);
      }
    } else if (f.wire === 5) {
      console.log(`${base} f32=${f32(f)}`);
    } else {
      console.log(`${base} varint=${f.value}`);
    }
  }
}

// ---- full extraction -----------------------------------------------------

function extractSetupRanges(buf: Buffer): Record<string, Range> | null {
  const top = decodeProtoMessage(buf);
  const g1 = nested(field(top, 1)!) ?? null; // mechanical/brakes/diff
  const g6 = nested(field(top, 6)!) ?? null; // aero
  const g7 = nested(field(top, 7)!) ?? null; // fuel
  if (!g1 && !g6) return null;

  const out: Record<string, Range> = {};
  if (g1) {
    const brakes = nested(field(g1, 3) ?? ({} as ProtoField));
    out.brakeBias = brakes ? readRange(field(brakes, 1)) : null;
  }
  if (g6) {
    out.frontRideHeight = readRange(field(g6, 2));
    out.rearRideHeight = readRange(field(g6, 3));
    out.frontWing = readRange(field(g6, 4));
    out.rearWing = readRange(field(g6, 5));
  }
  if (g7) {
    out.fuel = readRange(field(g7, 1));
  }
  // Drop keys that resolved to null-with-no-signal? No: null is meaningful
  // ("not tunable on this car") per the plan's JSON contract — keep them.
  return out;
}

/** Archive folder `ks_<model>` -> snapshot/cars.csv model key. */
function modelKey(folder: string): string {
  return folder.replace(/^ks_/, "");
}

/** Extract every car's ranges and rewrite shared/games/ac-evo/setup-ranges.json. Returns car count. */
export function runSetupRangesExtraction(kspkgPathArg?: string): number {
  const { pkg, cars } = collectCars(kspkgPathArg);
  const out: Record<string, Record<string, Range>> = {};
  try {
    for (const [car, entries] of [...cars.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // Prefer the shortest filename when a car ships variant limits (stock first).
      const entry = [...entries].sort((a, b) => a.path.length - b.path.length)[0];
      if (entries.length > 1) {
        console.error(`note: ${car} has ${entries.length} limits variants; using ${entry.path}`);
      }
      try {
        const ranges = extractSetupRanges(pkg.readFile(entry));
        if (ranges) out[modelKey(car)] = ranges;
        else console.error(`no setup block: ${car}`);
      } catch (err) {
        console.error(`failed ${car}: ${(err as Error).message}`);
      }
    }
  } finally {
    pkg.close();
  }

  const outPath = join(import.meta.dir, "..", "shared", "games", "ac-evo", "setup-ranges.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.error(`wrote ${outPath}: ${Object.keys(out).length} cars`);
  return Object.keys(out).length;
}

function main(): void {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const dumpCar = argValue("--dump");
  if (args.includes("--list") || dumpCar) {
    const { pkg, cars } = collectCars(argValue("--kspkg"));
    try {
      if (args.includes("--list")) {
        for (const name of [...cars.keys()].sort()) console.log(name);
        return;
      }
      const entries = cars.get(dumpCar!);
      if (!entries) {
        console.error(`car not found: ${dumpCar}`);
        process.exit(1);
      }
      for (const entry of entries) {
        const buf = pkg.readFile(entry);
        console.error(`${entry.path}: ${buf.length} bytes`);
        dumpTree(decodeProtoMessage(buf), "", 0);
      }
    } finally {
      pkg.close();
    }
    return;
  }

  runSetupRangesExtraction(argValue("--kspkg"));
}

if (import.meta.main) main();
