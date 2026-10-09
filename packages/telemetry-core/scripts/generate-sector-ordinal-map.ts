import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const source = resolve(root, "packages/game-fm-2023-metadata/src/tracks.csv");
const target = resolve(root, "packages/telemetry-core/src/processor/generated-sector-ordinal-map.ts");
const csv = await readFile(source, "utf8");
const rows = csv.trimEnd().split(/\r?\n/).slice(1);
const entries: [number, string][] = [];
for (const row of rows) {
  const [ordinal, name] = row.split(",", 3);
  const parsed = Number(ordinal);
  if (Number.isInteger(parsed) && name) entries.push([parsed, name]);
}
const generated = `// Generated from packages/game-fm-2023-metadata/src/tracks.csv. Do not edit.\nexport const TRACK_NAME_BY_ORDINAL: Readonly<Record<number, string>> = ${JSON.stringify(Object.fromEntries(entries), null, 2)};\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== generated) throw new Error("Generated sector ordinal map is stale; run bun packages/telemetry-core/scripts/generate-sector-ordinal-map.ts");
} else {
  await writeFile(target, generated);
}
