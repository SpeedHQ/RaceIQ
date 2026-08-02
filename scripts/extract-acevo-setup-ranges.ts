/**
 * Extract per-car setup ranges from AC Evo's content.kspkg.
 *
 * Source of truth: `content/cars/<ks_folder>/data/setup/*.carsetuplimits`
 * (protobuf). Verified layout (anchored via unit strings "N/m"/"Ns/m"/"PSI"/
 * "DEG"/"deg"/"mm" and cross-car diffs — see docs/contributing/setup-range-data.md):
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
 * ARB #1.#1 blocks are click-based: {#1 step, #2 min, #3 max} are UI clicks
 * with a #9 click→N/m LUT (verified against the known Audi GT3 ARB table:
 * front 1–3 → 16000/28000/40000 N/m, rear 1–3 → 49000/60000/69000 N/m).
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
  if (min === max) return null; // fixed value => not changeable on this car (e.g. SF25 caster/spring rate)
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
    // #1 x2 ARB blocks (front, rear). Each block: {#1 step, #2 min, #3 max,
    // #4 clickable, #6 LUT curve path, #9 click→N/m LUT}. min/max/step are UI
    // clicks (verified: Audi GT3 front 1–3 step 1 with LUT 16000/28000/40000
    // N/m matching the known in-game ARB table) — readRange emits clicks.
    const arbs = fieldsOf(g1, 1);
    out.frontARB = arbs.length > 0 ? readRange(arbs[0]) : null;
    out.rearARB = arbs.length > 1 ? readRange(arbs[1]) : null;
    out.steerRatio = readRange(field(g1, 2));
    const brakes = nested(field(g1, 3) ?? ({} as ProtoField));
    out.brakeBias = brakes ? readRange(field(brakes, 1)) : null;
    out.brakePressure = brakes ? readRange(field(brakes, 2)) : null;
    // #4 differential: #1 power ramp, #2 coast ramp, #3 preload (Nm).
    const diff = nested(field(g1, 4) ?? ({} as ProtoField));
    out.diffPower = diff ? readRange(field(diff, 1)) : null;
    out.diffCoast = diff ? readRange(field(diff, 2)) : null;
    out.diffPreload = diff ? readRange(field(diff, 3)) : null;
  }
  // #2 x4 per-corner spring blocks (FL, FR, RL, RR): corner.#1 spring rate
  // ("N/m" unit string). Emitted per-axle from FL/RL like camber/toe.
  const springCorners = fieldsOf(top, 2).map((f) => nested(f)).filter((c): c is ProtoField[] => !!c);
  if (springCorners.length === 4) {
    out.frontSpringRate = readRange(field(springCorners[0], 1));
    out.rearSpringRate = readRange(field(springCorners[2], 1));
  }
  // #3 x4 per-corner damper blocks: #1 slow bump clicks, #3 slow rebound
  // clicks (both carry the clickable flag; #2/#4 are the underlying Ns/m
  // rates, not UI knobs — omitted). Per-axle from FL/RL.
  const damperCorners = fieldsOf(top, 3).map((f) => nested(f)).filter((c): c is ProtoField[] => !!c);
  if (damperCorners.length === 4) {
    out.frontBump = readRange(field(damperCorners[0], 1));
    out.frontRebound = readRange(field(damperCorners[0], 3));
    out.rearBump = readRange(field(damperCorners[2], 1));
    out.rearRebound = readRange(field(damperCorners[2], 3));
  }
  // #4 x4 per-corner alignment/tyre blocks in FL, FR, RL, RR order (verified:
  // SF25 front camber −2.6…−1.5 in corners 0–1, rear −1.6…−0.8 in 2–3, and PSI
  // 13–25 vs the F1 slick pressures; "PSI"/"DEG" unit strings anchor the slots).
  //   corner.#1 tyre pressure (PSI) · #2 camber (DEG) · #3 toe (DEG)
  //   (#4 toe-rad / #5 caster / #6 etc. are fixed min==max blocks => null)
  const corners = fieldsOf(top, 4).map((f) => nested(f)).filter((c): c is ProtoField[] => !!c);
  if (corners.length === 4) {
    const [fl, fr, rl, rr] = corners;
    out.frontLeftTyrePressure = readRange(field(fl, 1));
    out.frontRightTyrePressure = readRange(field(fr, 1));
    out.rearLeftTyrePressure = readRange(field(rl, 1));
    out.rearRightTyrePressure = readRange(field(rr, 1));
    out.frontCamber = readRange(field(fl, 2));
    out.rearCamber = readRange(field(rl, 2));
    out.frontToe = readRange(field(fl, 3));
    out.rearToe = readRange(field(rl, 3));
  }
  // #5 electronics: #1 TC, #2 TC2, #3 ABS, #4 engine map (field numbers match
  // the setup-file electronics block labelled in carsetup.ts
  // ELECTRONICS_GUESSES; #5 "Telemetry laps" is not a setup knob — omitted).
  const g5 = nested(field(top, 5) ?? ({} as ProtoField));
  if (g5) {
    out.tc = readRange(field(g5, 1));
    out.tc2 = readRange(field(g5, 2));
    out.abs = readRange(field(g5, 3));
    out.engineMap = readRange(field(g5, 4));
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
