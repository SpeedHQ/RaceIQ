import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { resolve, basename } from "path";

// Gzips a single raw .bin dump next to itself (like `gzip -k` — original
// kept, .bin.gz created). The raw .bin stays gitignored; the .bin.gz is what
// you commit as a test fixture.
//
// Usage:
//   bun run gzip:recording test/artifacts/laps/fm-2023-2026-…-.bin

const target = process.argv[2];
if (!target) {
  console.error("Usage: bun run gzip:recording <path/to/file.bin>");
  process.exit(1);
}

const binPath = resolve(target);
if (!existsSync(binPath)) {
  console.error(`[err]  ${binPath} not found`);
  process.exit(1);
}
if (!binPath.endsWith(".bin")) {
  console.error(`[err]  expected a .bin file, got ${binPath}`);
  process.exit(1);
}

const gzPath = `${binPath}.gz`;
if (existsSync(gzPath)) {
  console.error(`[err]  ${basename(gzPath)} already exists — delete it first if you mean to re-gzip`);
  process.exit(1);
}

const raw = readFileSync(binPath);
writeFileSync(gzPath, gzipSync(raw));
const srcKb = (raw.length / 1024).toFixed(0);
const gzKb = (statSync(gzPath).size / 1024).toFixed(0);
console.log(`[ok]   ${basename(binPath)} (${srcKb} KB) -> ${basename(gzPath)} (${gzKb} KB)`);
