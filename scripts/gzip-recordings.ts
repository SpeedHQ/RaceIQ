import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { resolve, basename } from "path";

// Gzips raw .bin dumps under test/artifacts/laps/ into .bin.gz next to them,
// keeping the original (like `gzip -k`). Ready-to-commit as a test fixture —
// the raw .bin stays gitignored, only the .gz lands in the repo.
//
// Usage:
//   bun run gzip:recordings                 # all raw .bin files in default dir
//   bun run gzip:recordings path/to/foo.bin # single file

const DEFAULT_DIR = resolve(process.cwd(), "test", "artifacts", "laps");

function gzipFile(binPath: string): void {
  const gzPath = `${binPath}.gz`;
  if (existsSync(gzPath)) {
    console.log(`[skip] ${basename(gzPath)} already exists`);
    return;
  }
  const raw = readFileSync(binPath);
  writeFileSync(gzPath, gzipSync(raw));
  const srcKb = (raw.length / 1024).toFixed(0);
  const gzKb = (statSync(gzPath).size / 1024).toFixed(0);
  console.log(`[ok]   ${basename(binPath)} (${srcKb} KB) -> ${basename(gzPath)} (${gzKb} KB)`);
}

const target = process.argv[2];
if (target) {
  const binPath = resolve(target);
  if (!existsSync(binPath)) {
    console.error(`[err]  ${binPath} not found`);
    process.exit(1);
  }
  if (!binPath.endsWith(".bin")) {
    console.error(`[err]  expected a .bin file, got ${binPath}`);
    process.exit(1);
  }
  gzipFile(binPath);
} else {
  if (!existsSync(DEFAULT_DIR)) {
    console.error(`[err]  ${DEFAULT_DIR} not found`);
    process.exit(1);
  }
  const bins = readdirSync(DEFAULT_DIR).filter((f) => f.endsWith(".bin"));
  if (bins.length === 0) {
    console.log(`[info] no .bin files in ${DEFAULT_DIR}`);
    process.exit(0);
  }
  for (const f of bins) gzipFile(resolve(DEFAULT_DIR, f));
}
