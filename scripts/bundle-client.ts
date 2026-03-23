/**
 * Reads client/dist/ and generates a TypeScript module that embeds all
 * static assets as binary data, so `bun build --compile` produces a
 * single self-contained binary.
 */
import { readdir } from "fs/promises";
import path from "path";

const DIST = path.resolve(import.meta.dir, "..", "client", "dist");
const OUT = path.resolve(import.meta.dir, "..", "server", "client-assets.generated.ts");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".map": "application/json",
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(DIST);
const lines: string[] = [
  "// Auto-generated — do not edit. Run `bun scripts/bundle-client.ts` to regenerate.",
  "export const assets = new Map<string, { data: Uint8Array; type: string }>([",
];

for (const file of files) {
  const key = "/" + path.relative(DIST, file);
  const buf = await Bun.file(file).arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const mime = mimeFor(file);
  lines.push(`  [${JSON.stringify(key)}, { data: Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)), type: ${JSON.stringify(mime)} }],`);
}

lines.push("]);");

await Bun.write(OUT, lines.join("\n") + "\n");
console.log(`Bundled ${files.length} files → ${OUT}`);
