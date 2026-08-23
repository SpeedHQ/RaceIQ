import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveTrackImageryPackPath } from "../server/tracks/imagery-artifact";
import { TrackImageryVenueManifestSchema, type TrackImageryArtifact } from "../shared/racing/tracks/imagery";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(payload: Uint8Array): { directory: string; artifact: TrackImageryArtifact } {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-imagery-artifact-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    artifact: {
      url: "https://assets.example.test/imagery.rqi",
      version: "track-imagery-v1",
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.byteLength,
      attribution: "Test imagery",
    },
  };
}

test("uses a matching local pack without network access", async () => {
  const payload = Uint8Array.from([1, 2, 3, 4]);
  const { directory, artifact } = fixture(payload);
  const localPath = join(directory, "imagery.rqi");
  writeFileSync(localPath, payload);

  const resolved = await resolveTrackImageryPackPath(localPath, artifact, {
    cacheDirectory: join(directory, "cache"),
    fetcher: async () => {
      throw new Error("unexpected fetch");
    },
  });

  expect(resolved).toBe(localPath);
});

test("replaces a missing or invalid local pack with one verified cached download", async () => {
  const payload = Uint8Array.from([5, 6, 7, 8, 9]);
  const { directory, artifact } = fixture(payload);
  const localPath = join(directory, "imagery.rqi");
  const cacheDirectory = join(directory, "cache");
  writeFileSync(localPath, Uint8Array.from([0, 0, 0, 0, 0]));
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return new Response(payload);
  };

  const first = await resolveTrackImageryPackPath(localPath, artifact, { cacheDirectory, fetcher });
  const second = await resolveTrackImageryPackPath(join(directory, "missing.rqi"), artifact, { cacheDirectory, fetcher });

  expect(first).toBe(second);
  expect(readFileSync(first)).toEqual(Buffer.from(payload));
  expect(fetches).toBe(1);
});

test("rejects a corrupt download without retaining a cache file", async () => {
  const payload = Uint8Array.from([10, 11, 12, 13]);
  const { directory, artifact } = fixture(payload);
  const cacheDirectory = join(directory, "cache");
  const fetcher = async () => new Response(Uint8Array.from([13, 12, 11, 10]));

  await expect(resolveTrackImageryPackPath(join(directory, "missing.rqi"), artifact, { cacheDirectory, fetcher })).rejects.toThrow("SHA-256 mismatch");
  expect(readdirSync(cacheDirectory)).toEqual([]);
});

const CURATED_ARTIFACT_MANIFESTS = [
  "circuit-de-spa-francorchamps/revisions/2010/imagery/manifest.json",
  "circuit-de-spa-francorchamps/revisions/current/imagery/manifest.json",
  "daytona-international-speedway/revisions/current/imagery/manifest.json",
  "new-hampshire-motor-speedway/revisions/current/imagery/manifest.json",
] as const;

test("pins each curated LFS pack to matching artifact metadata", async () => {
  const venueRoot = resolve(process.cwd(), "shared", "data", "tracks", "venues");
  for (const relativeManifestPath of CURATED_ARTIFACT_MANIFESTS) {
    const manifestPath = resolve(venueRoot, relativeManifestPath);
    const manifest = TrackImageryVenueManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const artifact = manifest.base.artifact;
    if (!artifact) throw new Error(`Missing imagery artifact metadata in ${manifestPath}`);
    expect(artifact.attribution).toBe(manifest.base.source.attribution);
    const expectedUrlSuffix = relativeManifestPath.replace(/manifest\.json$/, manifest.base.pack).replaceAll("\\", "/");
    expect(artifact.url.endsWith(expectedUrlSuffix)).toBe(true);

    const packPath = resolve(manifestPath, "..", manifest.base.pack);
    const stat = statSync(packPath);
    if (stat.size < 1024) {
      const pointer = readFileSync(packPath, "utf8");
      expect(pointer).toContain(`oid sha256:${artifact.sha256}`);
      expect(pointer).toContain(`size ${artifact.sizeBytes}`);
      continue;
    }

    expect(stat.size).toBe(artifact.sizeBytes);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(packPath)) hash.update(chunk);
    expect(hash.digest("hex")).toBe(artifact.sha256);
  }
});
