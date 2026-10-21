import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@raceiq/shared/core/csv";

const root = resolve(import.meta.dir, "..");
const check = process.argv.includes("--check");

function generate(game: "game-acc-metadata" | "game-ac-evo-metadata"): string {
  const gameRoot = resolve(root, "..", game);
  const cars = readFileSync(resolve(gameRoot, "src/cars.csv"), "utf8").split(/\r?\n/).slice(1)
    .filter((line) => line.trim()).map(parseCsvLine).map((f) => ({ id: Number.parseInt(f[0]!, 10), model: f[1]!.trim(), name: f.slice(2, -1).join(",").trim() }));
  const tracks = readFileSync(resolve(gameRoot, "src/tracks.csv"), "utf8").split(/\r?\n/).slice(1)
    .filter((line) => line.trim()).map(parseCsvLine).map((f) => ({ id: Number.parseInt(f[0]!, 10), name: f[1]?.trim() ?? "", variant: f[2]?.trim() ?? "", commonTrackName: f[3]?.trim() ?? "", setupFolder: f[4]?.trim() ?? "" }));
  return `// Generated from authoritative cars.csv and tracks.csv. Do not edit.\nexport const cars = ${JSON.stringify(cars)} as const;\nexport const tracks = ${JSON.stringify(tracks)} as const;\n`;
}

for (const game of ["game-acc-metadata", "game-ac-evo-metadata"] as const) {
  const target = resolve(root, "..", game, "src/parser-data.generated.ts");
  const expected = generate(game);
  if (check) {
    if (readFileSync(target, "utf8") !== expected) throw new Error(`${target} is stale; run bun packages/game-acc-metadata/scripts/generate-parser-data.ts`);
  } else writeFileSync(target, expected);
}
