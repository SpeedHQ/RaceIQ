import { readdirSync, statSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { extname, join, relative, resolve } from "node:path";

type OptimizeOptions = {
  publicDir: string;
  dataDir?: string;
};

type Conversion = {
  inputPath: string;
  outputPath: string;
  relativePath: string;
  inputBytes: number;
  outputBytes: number;
};

const sourceExtensions: Record<string, true> = { ".png": true, ".jpg": true, ".jpeg": true };
const referenceExtensions = /\.(?:png|jpe?g)(?=($|[?#"'`),;\s]))/gi;
const textExtensions: Record<string, true> = { ".html": true, ".css": true, ".js": true, ".mjs": true, ".json": true, ".csv": true };
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function imageFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...imageFiles(path));
    else if (entry.isFile() && sourceExtensions[extname(entry.name).toLowerCase()]) files.push(path);
  }
  return files;
}

function textFiles(dir: string): string[] {
  if (!dir) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...textFiles(path));
    else if (entry.isFile() && textExtensions[extname(entry.name).toLowerCase()]) files.push(path);
  }
  return files;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return results;
}

function rewriteReferences(content: string, conversions: Conversion[]): string {
  let rewritten = content;
  for (const conversion of conversions) {
    const oldPath = `/${conversion.relativePath.replaceAll("\\", "/")}`;
    const newPath = oldPath.replace(referenceExtensions, ".webp");
    const exactPath = new RegExp("(?<![A-Za-z0-9+.-])" + escapeRegExp(oldPath) + "(?=($|[?#\"'`),;\\s]))", "g");
    rewritten = rewritten.replace(exactPath, newPath);
  }

  const localImagePath = new RegExp("(?<![A-Za-z0-9+.-])/(?:car-images|iracing-car-images)/[^\\s\"'`?#),;]+?\\.(?:png|jpe?g)(?=($|[?#\"'`),;\\s]))", "gi");
  rewritten = rewritten.replace(localImagePath, (value) => value.replace(referenceExtensions, ".webp"));

  rewritten = rewritten.replace(/(<link\b[^>]*\bhref=["']\/favicon\.webp["'][^>]*\btype=["'])image\/png/gi, "$1image/webp");
  rewritten = rewritten.replace(/(<link\b[^>]*\btype=["'])image\/png(["'][^>]*\bhref=["']\/favicon\.webp["'])/gi, "$1image/webp$2");
  return rewritten;
}

async function rewritePackagedReferences(conversions: Conversion[], publicDir: string, dataDir?: string): Promise<void> {
  const roots = [publicDir, dataDir].filter((dir): dir is string => Boolean(dir && statSync(dir, { throwIfNoEntry: false })));
  for (const path of roots.flatMap(textFiles)) {
    const file = Bun.file(path);
    const content = await file.text();
    const rewritten = rewriteReferences(content, conversions);
    if (rewritten !== content) await Bun.write(path, rewritten);
  }
}



export async function optimizeClientImages({ publicDir, dataDir }: OptimizeOptions): Promise<{ converted: number; inputBytes: number; outputBytes: number }> {
  const resolvedPublicDir = resolve(publicDir);
  const inputs = imageFiles(resolvedPublicDir);
  const concurrency = Math.max(1, Math.min(8, availableParallelism()));
  const conversions = await mapWithConcurrency(inputs, concurrency, async (inputPath) => {
    const metadata = await Bun.file(inputPath).image().metadata();
    const pipeline = Bun.file(inputPath).image();
    const outputPath = `${inputPath.slice(0, -extname(inputPath).length)}.webp`;
    if (metadata.width > 1600) pipeline.resize(1600);
    await pipeline.webp({ quality: 90 }).write(outputPath);
    const inputBytes = statSync(inputPath).size;
    const outputBytes = statSync(outputPath).size;
    unlinkSync(inputPath);
    return { inputPath, outputPath, relativePath: relative(resolvedPublicDir, inputPath), inputBytes, outputBytes } satisfies Conversion;
  });

  await rewritePackagedReferences(conversions, resolvedPublicDir, dataDir ? resolve(dataDir) : undefined);
  const inputBytes = conversions.reduce((total, conversion) => total + conversion.inputBytes, 0);
  const outputBytes = conversions.reduce((total, conversion) => total + conversion.outputBytes, 0);
  const saved = inputBytes - outputBytes;
  const percentage = inputBytes === 0 ? 0 : (saved / inputBytes) * 100;
  console.log(`Optimized client images: ${conversions.length} converted, ${inputBytes} → ${outputBytes} bytes, ${saved} bytes saved (${percentage.toFixed(1)}%)`);
  return { converted: conversions.length, inputBytes, outputBytes };
}

if (import.meta.main) {
  optimizeClientImages({ publicDir: process.argv[2] ?? "dist/public", dataDir: process.argv[3] ?? "dist/data" }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
