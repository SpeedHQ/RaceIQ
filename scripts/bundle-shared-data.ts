/**
 * Embeds shared/ data files (CSVs, JSONs, track outlines, boundaries, curbs)
 * into a TypeScript module so `bun build --compile` produces a self-contained binary.
 */
import { readdir } from "fs/promises";
import path from "path";

const SHARED = path.resolve(import.meta.dir, "..", "shared");
const OUT = path.resolve(import.meta.dir, "..", "server", "shared-data.generated.ts");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (
      entry.name.endsWith(".csv") ||
      entry.name.endsWith(".json")
    ) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(SHARED);
const lines: string[] = [
  "// Auto-generated — do not edit. Run `bun scripts/bundle-shared-data.ts` to regenerate.",
  "export const sharedData = new Map<string, string>([",
];

for (const file of files) {
  // Key is relative to shared/, e.g. "tracks.csv", "track-outlines/boundaries/nurburgring.json"
  const key = path.relative(SHARED, file);
  const content = await Bun.file(file).text();
  lines.push(`  [${JSON.stringify(key)}, ${JSON.stringify(content)}],`);
}

lines.push("]);");

await Bun.write(OUT, lines.join("\n") + "\n");
console.log(`Bundled ${files.length} shared data files → ${OUT}`);
