#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { VISUAL_DIFF_COLOR_THRESHOLD, VISUAL_DIFF_MAX_PIXEL_RATIO } from "./visual-diff-config";

type ChangeStatus = "added" | "changed" | "removed";

export interface ScreenshotDiffOptions {
  baseDir: string;
  currentDir: string;
  outDir: string;
  prefix: string;
  includeMissing?: boolean;
}

interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface ScreenshotDiff {
  status: ChangeStatus;
  prefix: string;
  relativePath: string;
  stem: string;
  width: number;
  height: number;
  differingPixels: number | null;
  pixelRatio: number;
  beforeFile: string;
  afterFile: string;
  diffFile: string;
}

interface ImageComparison {
  matches: boolean;
  differingPixels: number;
  pixelRatio: number;
}

function listPngs(root: string, dir = root, files = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "results") {
      listPngs(root, path, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      files.set(relative(root, path).split(sep).join("/"), path);
    }
  }
  return files;
}

async function decode(path: string): Promise<DecodedImage> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function compareImages(base: DecodedImage, current: DecodedImage): ImageComparison {
  if (base.width !== current.width || base.height !== current.height) {
    return { matches: false, differingPixels: 0, pixelRatio: 1 };
  }

  const pixelCount = base.width * base.height;
  const differingPixels = pixelmatch(base.data, current.data, undefined, base.width, base.height, {
    threshold: VISUAL_DIFF_COLOR_THRESHOLD,
  });
  const pixelRatio = differingPixels / pixelCount;
  return {
    matches: pixelRatio <= VISUAL_DIFF_MAX_PIXEL_RATIO,
    differingPixels,
    pixelRatio,
  };
}

function placeholder(width: number, height: number, label: string): Promise<Buffer> {
  const fontSize = Math.max(16, Math.min(40, Math.floor(width / 18)));
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#111827"/>` +
      `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ` +
      `fill="#cbd5e1" font-family="sans-serif" font-size="${fontSize}">${label}</text>` +
      `</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

function blankCanvas(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 17, g: 24, b: 39, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function fitOnCanvas(path: string, width: number, height: number): Promise<Buffer> {
  const metadata = await sharp(path).metadata();
  return sharp(path)
    .ensureAlpha()
    .extend({
      right: width - (metadata.width ?? width),
      bottom: height - (metadata.height ?? height),
      background: { r: 17, g: 24, b: 39, alpha: 1 },
    })
    .png()
    .toBuffer();
}

function outputStem(status: ChangeStatus, prefix: string, relativePath: string): string {
  const logicalPath = relativePath.replace(/\.png$/i, "").replace(/^snapshot-/, "");
  const parts = [status, prefix, ...logicalPath.split("/")];
  return parts
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("--");
}

async function writeTriplet(
  options: ScreenshotDiffOptions,
  status: ChangeStatus,
  relativePath: string,
  basePath?: string,
  currentPath?: string,
): Promise<Pick<ScreenshotDiff, "stem" | "width" | "height" | "beforeFile" | "afterFile" | "diffFile">> {
  const baseImage = basePath ? await decode(basePath) : undefined;
  const currentImage = currentPath ? await decode(currentPath) : undefined;
  const width = Math.max(baseImage?.width ?? 0, currentImage?.width ?? 0);
  const height = Math.max(baseImage?.height ?? 0, currentImage?.height ?? 0);

  const before = basePath
    ? await fitOnCanvas(basePath, width, height)
    : await placeholder(width, height, "New screenshot");
  const after = currentPath
    ? await fitOnCanvas(currentPath, width, height)
    : await placeholder(width, height, "Screenshot removed");
  const blank = !basePath || !currentPath ? await blankCanvas(width, height) : undefined;
  const diffBefore = basePath ? before : blank!;
  const diffAfter = currentPath ? after : blank!;
  const diff = await sharp(diffBefore)
    .composite([{ input: diffAfter, blend: "difference" }])
    .png()
    .toBuffer();
  const stem = outputStem(status, options.prefix, relativePath);
  const beforeFile = `${stem}-before.png`;
  const afterFile = `${stem}-after.png`;
  const diffFile = `${stem}-diff.png`;

  await Promise.all([
    Bun.write(join(options.outDir, beforeFile), before),
    Bun.write(join(options.outDir, afterFile), after),
    Bun.write(join(options.outDir, diffFile), diff),
  ]);
  console.log(`${status} screenshot: ${relativePath}`);
  return { stem, width, height, beforeFile, afterFile, diffFile };
}

export async function collectScreenshotDiffs(options: ScreenshotDiffOptions): Promise<ScreenshotDiff[]> {
  mkdirSync(options.outDir, { recursive: true });
  const baseFiles = listPngs(options.baseDir);
  const currentFiles = listPngs(options.currentDir);
  const paths = [...new Set([...baseFiles.keys(), ...currentFiles.keys()])].sort();
  const changes: ScreenshotDiff[] = [];

  for (const relativePath of paths) {
    const basePath = baseFiles.get(relativePath);
    const currentPath = currentFiles.get(relativePath);
    if (options.includeMissing === false && (!basePath || !currentPath)) continue;

    let status: ChangeStatus;
    let comparison: ImageComparison | undefined;

    if (!basePath) {
      status = "added";
    } else if (!currentPath) {
      status = "removed";
    } else {
      const [baseImage, currentImage] = await Promise.all([decode(basePath), decode(currentPath)]);
      comparison = compareImages(baseImage, currentImage);
      if (comparison.matches) continue;
      status = "changed";
    }

    const output = await writeTriplet(options, status, relativePath, basePath, currentPath);
    changes.push({
      status,
      prefix: options.prefix,
      relativePath,
      ...output,
      differingPixels: comparison?.differingPixels ?? null,
      pixelRatio: comparison?.pixelRatio ?? 1,
    });
  }

  return changes;
}

function parseArgs(args: string[]): ScreenshotDiffOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`);
    values.set(key.slice(2), value);
  }

  const baseDir = values.get("base");
  const currentDir = values.get("current");
  const outDir = values.get("out");
  const prefix = values.get("prefix");
  if (!baseDir || !currentDir || !outDir || !prefix) {
    throw new Error("Usage: collect-screenshot-diffs --base DIR --current DIR --out DIR --prefix NAME");
  }
  return { baseDir, currentDir, outDir, prefix };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const changes = await collectScreenshotDiffs(options);
  console.log(`Collected ${changes.length} screenshot diff${changes.length === 1 ? "" : "s"}.`);
}
