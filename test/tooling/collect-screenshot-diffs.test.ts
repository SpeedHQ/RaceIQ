import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-screenshot-diff-"));
  tempDirs.push(dir);
  return dir;
}

async function writePng(
  path: string,
  color: { r: number; g: number; b: number },
  width = 3,
  height = 2,
): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toFile(path);
}

async function writeRawPng(path: string, pixels: Buffer, width: number, height: number): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collect-screenshot-diffs", () => {
  test("lists changed, added, and removed screenshots while omitting identical ones", async () => {
    const root = makeTempDir();
    const base = join(root, "base");
    const current = join(root, "current");
    const out = join(root, "out");

    await writePng(join(base, "mobile", "changed.png"), { r: 255, g: 0, b: 0 });
    await writePng(join(current, "mobile", "changed.png"), { r: 0, g: 255, b: 0 });
    await writePng(join(base, "mobile", "same.png"), { r: 0, g: 0, b: 255 });
    await writePng(join(current, "mobile", "same.png"), { r: 0, g: 0, b: 255 });
    await writePng(join(current, "tablet", "new-page.png"), { r: 255, g: 255, b: 0 }, 300, 100);
    await writePng(join(base, "desktop", "removed-page.png"), { r: 255, g: 0, b: 255 });
    await writePng(join(current, "results", "transient.png"), { r: 0, g: 255, b: 255 });

    const proc = Bun.spawn(
      [
        "bun",
        "scripts/ui/collect-screenshot-diffs.ts",
        "--base",
        base,
        "--current",
        current,
        "--out",
        out,
        "--prefix",
        "responsive",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode, stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "added--responsive--tablet--new-page-after.png",
      "added--responsive--tablet--new-page-before.png",
      "added--responsive--tablet--new-page-diff.png",
      "changed--responsive--mobile--changed-after.png",
      "changed--responsive--mobile--changed-before.png",
      "changed--responsive--mobile--changed-diff.png",
      "removed--responsive--desktop--removed-page-after.png",
      "removed--responsive--desktop--removed-page-before.png",
      "removed--responsive--desktop--removed-page-diff.png",
    ]);
    expect(existsSync(join(out, "responsive--mobile--same-after.png"))).toBe(false);

    const blank = await sharp({
      create: {
        width: 300,
        height: 100,
        channels: 4,
        background: { r: 17, g: 24, b: 39, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const expectedAddedDiff = await sharp(blank)
      .composite([
        {
          input: join(out, "added--responsive--tablet--new-page-after.png"),
          blend: "difference",
        },
      ])
      .raw()
      .toBuffer();
    const actualAddedDiff = await sharp(join(out, "added--responsive--tablet--new-page-diff.png"))
      .raw()
      .toBuffer();
    expect(actualAddedDiff.equals(expectedAddedDiff)).toBe(true);
  });
  test("ignores sparse one-level antialiasing differences", async () => {
    const root = makeTempDir();
    const base = join(root, "base");
    const current = join(root, "current");
    const out = join(root, "out");
    const width = 1000;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 0);

    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 20;
      pixels[offset + 1] = 20;
      pixels[offset + 2] = 20;
      pixels[offset + 3] = 255;
    }

    const currentPixels = Buffer.from(pixels);
    for (const offset of [0, 4, 8]) {
      currentPixels[offset] += 1;
      currentPixels[offset + 1] += 1;
      currentPixels[offset + 2] += 1;
    }

    await mkdirSync(join(base, "desktop"), { recursive: true });
    await mkdirSync(join(current, "desktop"), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(join(base, "desktop", "antialias.png"));
    await sharp(currentPixels, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(join(current, "desktop", "antialias.png"));

    const proc = Bun.spawn(
      ["bun", "scripts/ui/collect-screenshot-diffs.ts", "--base", base, "--current", current, "--out", out, "--prefix", "responsive"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );

    expect(await proc.exited).toBe(0);
    expect(readdirSync(out)).toEqual([]);
  });

  test("ignores an isolated material-color pixel within the allowed ratio", async () => {
    const root = makeTempDir();
    const base = join(root, "base");
    const current = join(root, "current");
    const out = join(root, "out");
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 20);

    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
    const currentPixels = Buffer.from(pixels);
    currentPixels[0] = 255;
    currentPixels[1] = 255;
    currentPixels[2] = 255;

    await writeRawPng(join(base, "desktop", "isolated.png"), pixels, width, height);
    await writeRawPng(join(current, "desktop", "isolated.png"), currentPixels, width, height);

    const proc = Bun.spawn(
      ["bun", "scripts/ui/collect-screenshot-diffs.ts", "--base", base, "--current", current, "--out", out, "--prefix", "responsive"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );

    expect(await proc.exited).toBe(0);
    expect(readdirSync(out)).toEqual([]);
  });

  test("keeps reporting material changes beyond the allowed ratio", async () => {
    const root = makeTempDir();
    const base = join(root, "base");
    const current = join(root, "current");
    const out = join(root, "out");
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4, 0);

    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 20;
      pixels[offset + 1] = 20;
      pixels[offset + 2] = 20;
      pixels[offset + 3] = 255;
    }

    const currentPixels = Buffer.from(pixels);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const offset = (y * width + x) * 4;
        currentPixels[offset] = 255;
        currentPixels[offset + 1] = 255;
        currentPixels[offset + 2] = 255;
      }
    }

    await writeRawPng(join(base, "desktop", "changed.png"), pixels, width, height);
    await writeRawPng(join(current, "desktop", "changed.png"), currentPixels, width, height);

    const proc = Bun.spawn(
      ["bun", "scripts/ui/collect-screenshot-diffs.ts", "--base", base, "--current", current, "--out", out, "--prefix", "responsive"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );

    expect(await proc.exited).toBe(0);
    expect(existsSync(join(out, "changed--responsive--desktop--changed-diff.png"))).toBe(true);
  });

  test("reports same-path dimension changes", async () => {
    const root = makeTempDir();
    const base = join(root, "base");
    const current = join(root, "current");
    const out = join(root, "out");

    await writePng(join(base, "desktop", "resized.png"), { r: 20, g: 20, b: 20 }, 100, 100);
    await writePng(join(current, "desktop", "resized.png"), { r: 20, g: 20, b: 20 }, 101, 100);

    const proc = Bun.spawn(
      ["bun", "scripts/ui/collect-screenshot-diffs.ts", "--base", base, "--current", current, "--out", out, "--prefix", "responsive"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );

    expect(await proc.exited).toBe(0);
    expect(existsSync(join(out, "changed--responsive--desktop--resized-diff.png"))).toBe(true);
  });
});
