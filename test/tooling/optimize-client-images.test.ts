import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { optimizeClientImages } from "../../scripts/build/optimize-client-images";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-optimize-images-"));
  tempDirs.push(dir);
  return dir;
}
async function createFixtures(publicDir: string, dataDir: string): Promise<{ inputBytes: number }> {

  const carDir = join(publicDir, "car-images");
  const iracingDir = join(publicDir, "iracing-car-images");
  mkdirSync(carDir, { recursive: true });
  mkdirSync(iracingDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  await Bun.write(join(carDir, "opaque.jpg"), await sharp({ create: { width: 80, height: 40, channels: 3, background: "#d95f02" } }).jpeg().toBuffer());
  await Bun.write(join(carDir, "transparent.png"), await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 0.35 } } }).png().toBuffer());
  await Bun.write(join(iracingDir, "large.jpeg"), await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#1b9e77" } }).jpeg().toBuffer());
  await Bun.write(join(publicDir, "favicon.png"), await sharp({ create: { width: 32, height: 32, channels: 4, background: "#000000" } }).png().toBuffer());
  await Bun.write(join(publicDir, "app.js"), 'const a = "/car-images/opaque.jpg"; const b = `/car-images/${id}.jpg`; const external = "https://example.test/photo.jpg"; const externalPath = "https://example.test/car-images/opaque.jpg";');
  await Bun.write(join(publicDir, "index.html"), '<link rel="icon" href="/favicon.png" type="image/png">');
  await Bun.write(join(dataDir, "cars.csv"), "car,/iracing-car-images/large.jpeg\n");
  writeFileSync(join(publicDir, "keep.txt"), "https://example.test/keep.jpg");
  const inputBytes = ["opaque.jpg", "transparent.png"].reduce((sum, name) => sum + statSync(join(carDir, name)).size, 0)
    + statSync(join(iracingDir, "large.jpeg")).size + statSync(join(publicDir, "favicon.png")).size;
  return { inputBytes };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("optimizeClientImages", () => {
  test("converts, resizes, preserves alpha, and rewrites packaged references", async () => {
    const root = tempDir();
    const publicDir = join(root, "public");
    const dataDir = join(root, "data");
    const { inputBytes } = await createFixtures(publicDir, dataDir);

    const summary = await optimizeClientImages({ publicDir, dataDir });

    expect(summary.converted).toBe(4);
    expect(summary.inputBytes).toBe(inputBytes);
    expect(summary.outputBytes).toBe(
      statSync(join(publicDir, "car-images/opaque.webp")).size
      + statSync(join(publicDir, "car-images/transparent.webp")).size
      + statSync(join(publicDir, "iracing-car-images/large.webp")).size
      + statSync(join(publicDir, "favicon.webp")).size,
    );
    for (const path of ["car-images/opaque.jpg", "car-images/transparent.png", "iracing-car-images/large.jpeg", "favicon.png"]) {
      expect(existsSync(join(publicDir, path))).toBe(false);
    }

    const opaque = await Bun.file(join(publicDir, "car-images/opaque.webp")).image().metadata();
    const transparent = await Bun.file(join(publicDir, "car-images/transparent.webp")).image().metadata();
    const large = await Bun.file(join(publicDir, "iracing-car-images/large.webp")).image().metadata();
    const transparentAlpha = await sharp(join(publicDir, "car-images/transparent.webp")).metadata();
    expect(opaque.format).toBe("webp");
    expect(transparent.format).toBe("webp");
    expect(transparentAlpha.hasAlpha).toBe(true);
    expect(large.width).toBe(1600);
    expect(large.height).toBe(800);

    expect(readFileSync(join(publicDir, "app.js"), "utf8")).toContain("/car-images/opaque.webp");
    expect(readFileSync(join(publicDir, "app.js"), "utf8")).toContain("/car-images/${id}.webp");
    expect(readFileSync(join(publicDir, "app.js"), "utf8")).toContain("https://example.test/car-images/opaque.jpg");
    expect(readFileSync(join(publicDir, "app.js"), "utf8")).toContain("https://example.test/photo.jpg");
    expect(readFileSync(join(publicDir, "index.html"), "utf8")).toContain('href="/favicon.webp" type="image/webp"');
    expect(readFileSync(join(dataDir, "cars.csv"), "utf8")).toContain("/iracing-car-images/large.webp");
    expect(readFileSync(join(publicDir, "keep.txt"), "utf8")).toContain("keep.jpg");
  });

  test("rejects malformed images and preserves original", async () => {
    const root = tempDir();
    const publicDir = join(root, "public");
    const malformed = join(publicDir, "broken.jpg");
    await Bun.write(malformed, "not an image");

    await expect(optimizeClientImages({ publicDir })).rejects.toThrow();
    expect(existsSync(malformed)).toBe(true);
    expect(existsSync(join(publicDir, "broken.webp"))).toBe(false);
  });
});
