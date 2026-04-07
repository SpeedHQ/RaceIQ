#!/usr/bin/env bun
/**
 * Extract wheel positions from Forza Motorsport car files to compute
 * wheelbase, front/rear track width, and body length for each car.
 * Reads Locators.xml from each car ZIP in the game install directory,
 * then matches to car ordinals via cars.csv name fuzzy-matching.
 *
 * Output: shared/car-dimensions.csv — keyed by car ordinal
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parseForzaZip, decompressForzaLZX, findForzaInstall } from "../shared/lib/forza-lzx";

const forzaDir = findForzaInstall();
if (!forzaDir) {
  console.error("Forza Motorsport install not found");
  process.exit(1);
}

const carDir = resolve(forzaDir, "media/pcfamily/cars");
const carZips = readdirSync(carDir).filter((f) => f.endsWith(".zip"));
console.log(`Found ${carZips.length} car ZIPs in ${carDir}`);

interface WheelPos {
  x: number;
  y: number;
  z: number;
}

interface CarDimensions {
  wheelbase: number;
  halfWheelbase: number;
  frontTrack: number;
  halfFrontTrack: number;
  rearTrack: number;
  halfRearTrack: number;
  bodyLength: number;
  wheelLF: WheelPos;
  wheelRF: WheelPos;
  wheelLR: WheelPos;
  wheelRR: WheelPos;
}

function extractTranslation(block: string): WheelPos | null {
  const m41 = block.match(/value\._41="([^"]+)"/);
  const m42 = block.match(/value\._42="([^"]+)"/);
  const m43 = block.match(/value\._43="([^"]+)"/);
  if (!m41 || !m42 || !m43) return null;
  return {
    x: parseFloat(m41[1]),
    y: parseFloat(m42[1]),
    z: parseFloat(m43[1]),
  };
}

const results: Record<string, CarDimensions> = {};
let extracted = 0;
let failed = 0;

for (const zipFile of carZips) {
  const zipName = zipFile.replace(".zip", "");
  try {
    const { buf, entries } = parseForzaZip(resolve(carDir, zipFile));
    const entry = entries.find((e) => e.name === "Locators.xml");
    if (!entry) {
      failed++;
      continue;
    }

    const compressed = buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
    const data = decompressForzaLZX(compressed, entry.uncompSize);
    const xml = data.toString("utf8");

    // Extract wheel locator positions
    const wheels: Record<string, WheelPos> = {};
    for (const name of ["wheelLF", "wheelRF", "wheelLR", "wheelRR"]) {
      const idx = xml.indexOf(`carLocator_${name}`);
      if (idx < 0) continue;
      // Find the enclosing <Locator> block
      const blockStart = xml.lastIndexOf("<Locator", idx);
      const blockEnd = xml.indexOf("</Locator>", idx);
      if (blockStart < 0 || blockEnd < 0) continue;
      const block = xml.substring(blockStart, blockEnd);
      const pos = extractTranslation(block);
      if (pos) wheels[name] = pos;
    }

    if (!wheels.wheelLF || !wheels.wheelRF || !wheels.wheelLR || !wheels.wheelRR) {
      failed++;
      continue;
    }

    const frontZ = (wheels.wheelLF.z + wheels.wheelRF.z) / 2;
    const rearZ = (wheels.wheelLR.z + wheels.wheelRR.z) / 2;
    const wheelbase = Math.abs(frontZ - rearZ);
    const frontTrack = Math.abs(wheels.wheelRF.x - wheels.wheelLF.x);
    const rearTrack = Math.abs(wheels.wheelRR.x - wheels.wheelLR.x);
    // Body length estimate: wheelbase + ~0.8m overhang front + ~0.7m rear
    const bodyLength = wheelbase + 1.5;

    results[zipName] = {
      wheelbase: +wheelbase.toFixed(4),
      halfWheelbase: +(wheelbase / 2).toFixed(4),
      frontTrack: +frontTrack.toFixed(4),
      halfFrontTrack: +(frontTrack / 2).toFixed(4),
      rearTrack: +rearTrack.toFixed(4),
      halfRearTrack: +(rearTrack / 2).toFixed(4),
      bodyLength: +bodyLength.toFixed(4),
      wheelLF: wheels.wheelLF,
      wheelRF: wheels.wheelRF,
      wheelLR: wheels.wheelLR,
      wheelRR: wheels.wheelRR,
    };
    extracted++;
  } catch {
    failed++;
  }
}

console.log(`\nExtracted ${extracted} cars, ${failed} failed/skipped`);

// Show a few examples
const examples = Object.entries(results).slice(0, 5);
for (const [name, dims] of examples) {
  console.log(`  ${name}: WB=${(dims.wheelbase * 1000).toFixed(0)}mm FT=${(dims.frontTrack * 1000).toFixed(0)}mm RT=${(dims.rearTrack * 1000).toFixed(0)}mm`);
}

// ── Build ordinal-keyed CSV by matching ZIP names to cars.csv ──

const makeAbbr: Record<string, string[]> = {
  "acura": ["acu"], "alfa romeo": ["alf"], "amc": ["amc"], "apollo": ["apo"],
  "ariel": ["ari"], "aston martin": ["ast"], "audi": ["aud"], "bentley": ["ben"],
  "bmw": ["bmw"], "bugatti": ["bug"], "buick": ["bui"], "cadillac": ["cad"],
  "caterham": ["cat"], "chevrolet": ["che"], "chrysler": ["chr"], "datsun": ["dat"],
  "dodge": ["dod"], "donkervoort": ["don"], "eagle": ["eag"], "ferrari": ["fer"],
  "fiat": ["fia"], "ford": ["for"], "genesis": ["gen"], "gmc": ["gmc"],
  "honda": ["hon"], "hoonigan": ["hoo"], "hyundai": ["hyu"], "infiniti": ["inf"],
  "jaguar": ["jag"], "jeep": ["jee"], "koenigsegg": ["koe"], "ktm": ["ktm"],
  "lamborghini": ["lam"], "lancia": ["lan"], "land rover": ["lan"], "lexus": ["lex"],
  "lincoln": ["lin"], "local motors": ["loc"], "lotus": ["lot"], "maserati": ["mas"],
  "mazda": ["maz"], "mclaren": ["mcl"], "mercedes-benz": ["mer"], "mini": ["min"],
  "mitsubishi": ["mit"], "nissan": ["nis"], "noble": ["nob"], "oldsmobile": ["old"],
  "pagani": ["pag"], "peugeot": ["peu"], "plymouth": ["ply"], "pontiac": ["pon"],
  "porsche": ["por"], "radical": ["rad"], "ram": ["ram"], "renault": ["ren"],
  "rimac": ["rim"], "rivian": ["riv"], "shelby": ["she"], "subaru": ["sub"],
  "suzuki": ["suz"], "toyota": ["toy"], "vauxhall": ["vau"], "volkswagen": ["vol"],
  "volvo": ["vlv"],
};

const carsRaw = readFileSync(resolve(__dirname, "../shared/games/fm-2023/cars.csv"), "utf-8").trim().split("\n");
const zipNames = Object.keys(results);

const csvLines = ["ordinal,wheelbase,halfWheelbase,frontTrack,halfFrontTrack,rearTrack,halfRearTrack,bodyLength"];
let matched = 0;

for (const line of carsRaw) {
  const [ordStr, yearStr, make, ...modelParts] = line.split(",");
  const ordinal = parseInt(ordStr);
  const year = parseInt(yearStr);
  if (isNaN(ordinal) || isNaN(year) || !make) continue;
  const model = modelParts.join(",");
  const yearSuffix = String(year).slice(-2);
  const makeKey = make.toLowerCase();
  const abbrs = makeAbbr[makeKey] || [makeKey.substring(0, 3)];
  const modelClean = model.toLowerCase().replace(/[^a-z0-9]/g, "");

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const zip of zipNames) {
    const parts = zip.toLowerCase().split("_");
    if (!abbrs.some((a) => parts[0] === a)) continue;
    if (parts[parts.length - 1] !== yearSuffix) continue;
    const zipModelClean = parts.slice(1, -1).join("").replace(/^\d+/, "");
    let score = 0;
    for (let len = Math.min(zipModelClean.length, modelClean.length); len >= 3; len--) {
      for (let i = 0; i <= modelClean.length - len; i++) {
        if (zipModelClean.includes(modelClean.substring(i, i + len))) {
          score = Math.max(score, len);
        }
      }
      if (score >= 3) break;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = zip;
    }
  }

  if (bestMatch && bestScore >= 3) {
    const d = results[bestMatch];
    csvLines.push(`${ordinal},${d.wheelbase},${d.halfWheelbase},${d.frontTrack},${d.halfFrontTrack},${d.rearTrack},${d.halfRearTrack},${d.bodyLength}`);
    matched++;
  }
}

const csvPath = resolve(__dirname, "../shared/games/fm-2023/car-dimensions.csv");
writeFileSync(csvPath, csvLines.join("\n") + "\n");
console.log(`\nOrdinal mapping: ${matched} cars matched → ${csvPath}`);
