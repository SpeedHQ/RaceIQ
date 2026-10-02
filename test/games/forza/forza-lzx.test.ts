import { describe, it, expect } from "bun:test";
import { findForzaInstall } from "@shared/integrations/forza/install";
import { decompressForzaLZX } from "@shared/integrations/forza/lzx-decoder";
import { parseForzaZip } from "@shared/integrations/forza/zip";

describe("decompressForzaLZX", () => {
  it("decompresses small FF-header file", () => {
    const forzaDir = findForzaInstall();
    if (!forzaDir) return;
    const { buf, entries } = parseForzaZip(`${forzaDir}/media/pcfamily/tracks/spa/ribbon_00.zip`);
    const seg = entries.find((e) => e.name === "AI/Track.seg")!;
    expect(seg).toBeDefined();
    const compressed = buf.subarray(seg.dataStart, seg.dataStart + seg.compSize);
    const result = decompressForzaLZX(compressed, seg.uncompSize);
    expect(result.length).toBe(seg.uncompSize);
    expect(result.toString("utf8").startsWith("MLPDataStart:")).toBe(true);
  });

  it("decompresses large file with waypoint data", () => {
    const forzaDir = findForzaInstall();
    if (!forzaDir) return;
    const { buf, entries } = parseForzaZip(`${forzaDir}/media/pcfamily/tracks/spa/ribbon_00.zip`);
    const geo = entries.find((e) => e.name === "AI/Track.geo")!;
    expect(geo).toBeDefined();
    const compressed = buf.subarray(geo.dataStart, geo.dataStart + geo.compSize);
    const result = decompressForzaLZX(compressed, geo.uncompSize);
    // Must fully decompress (100%) to access TrackLimits boundary data
    expect(result.length).toBe(geo.uncompSize);
    expect(result.toString("utf8").startsWith("MLPDataStart:")).toBe(true);
  }, { timeout: 30_000 });
});

describe("parseForzaZip", () => {
  it("parses ZIP entries from ribbon file", () => {
    const forzaDir = findForzaInstall();
    if (!forzaDir) return;
    const { entries } = parseForzaZip(`${forzaDir}/media/pcfamily/tracks/spa/ribbon_00.zip`);
    expect(entries.length).toBeGreaterThan(0);
    const geo = entries.find(e => e.name === "AI/Track.geo");
    expect(geo).toBeDefined();
    expect(geo!.compSize).toBeGreaterThan(0);
    expect(geo!.uncompSize).toBeGreaterThan(geo!.compSize);
  });
});

describe("findForzaInstall", () => {
  it("returns a path or null", () => {
    const result = findForzaInstall();
    // Can't assert it's found (CI won't have FM2023), but it shouldn't throw
    expect(result === null || typeof result === "string").toBe(true);
  });
});
