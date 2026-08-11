import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  parseGoldenRecordingManifest,
  readGoldenRecordingManifest,
  validateGoldenRecordingDirectory,
  verifyGoldenRecordingArtifact,
} from "../../scripts/telemetry/recordings/golden-manifest";

const ROOT_DIR = resolve(import.meta.dir, "../..");
const MANIFEST_DIR = resolve(ROOT_DIR, "test", "golden-recordings");
const ACC_MANIFEST_PATH = resolve(
  MANIFEST_DIR,
  "acc-gt3-spa-v1.golden.json",
);

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("golden recording manifests", () => {
  test("keeps ACC v1 intent, observations, and validation scope explicit", () => {
    const manifest = readGoldenRecordingManifest(ACC_MANIFEST_PATH);

    expect(manifest.id).toBe("acc-gt3-spa-v1");
    expect(manifest.status).toBe("accepted");
    expect(manifest.observations.actual_completed_laps.value).toBe(13);
    expect(manifest.observations.lap_alignment).toHaveLength(13);
    expect(
      manifest.observations.lap_alignment.find(
        (lap) => lap.source_completed_lap === 4,
      ),
    ).toMatchObject({ coverage: "missing", raceiq_lap_row: null });
    expect(
      manifest.observations.events.find(
        (event) => event.id === "stint-1-eau-rouge-cut",
      )?.evidence,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source_observed",
          detail: expect.stringContaining("isValidLap became false"),
        }),
      ]),
    );
    expect(
      manifest.validation_roles.find(
        (role) => role.role === "pit_service",
      )?.enabled,
    ).toBe(false);
    expect(
      manifest.validation_roles.find(
        (role) => role.role === "abnormal_event_analysis",
      )?.enabled,
    ).toBe(true);
  });

  test(
    "verifies registered compressed and source identities",
    async () => {
      const validated = await validateGoldenRecordingDirectory(
        MANIFEST_DIR,
        ROOT_DIR,
      );

      expect(validated).toHaveLength(1);
      expect(validated[0].manifest.id).toBe("acc-gt3-spa-v1");
      expect(validated[0].verification.artifactBytes).toBe(85_468_118);
      expect(validated[0].verification.uncompressedBytes).toBe(610_631_308);
    },
    120_000,
  );

  test("rejects unknown fields and mismatched identity versions", () => {
    const manifest = JSON.parse(
      JSON.stringify(readGoldenRecordingManifest(ACC_MANIFEST_PATH)),
    );

    expect(() =>
      parseGoldenRecordingManifest({ ...manifest, unexpected: true }),
    ).toThrow("Unrecognized key");
    expect(() =>
      parseGoldenRecordingManifest({
        ...manifest,
        id: "acc-gt3-spa-v2",
      }),
    ).toThrow("ID version suffix must match recording_version");
  });

  test("rejects an artifact whose uncompressed source hash changed", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "golden-recording-"));
    try {
      const source = Buffer.from("deterministic golden source");
      const compressed = gzipSync(source);
      writeFileSync(join(tempRoot, "fixture.bin.gz"), compressed);

      const manifest = structuredClone(
        readGoldenRecordingManifest(ACC_MANIFEST_PATH),
      );
      manifest.artifact = {
        ...manifest.artifact,
        path: "fixture.bin.gz",
        byte_length: compressed.length,
        sha256: sha256(compressed),
        uncompressed_byte_length: source.length,
        uncompressed_sha256: `sha256:${"0".repeat(64)}`,
      };

      await expect(
        verifyGoldenRecordingArtifact(manifest, tempRoot),
      ).rejects.toThrow("uncompressed SHA-256 mismatch");
    } finally {
      rmSync(tempRoot, { recursive: true });
    }
  });
});
