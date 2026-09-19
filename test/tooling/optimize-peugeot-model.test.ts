import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { optimizePeugeotModel, PEUGEOT_SOURCE_SHA256 } from "../../scripts/assets/optimize-peugeot-model";

const sourcePath = resolve("assets/models/source/peugeot_9x8_evo_2024.glb");

function createIO(): NodeIO {
  return new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}

describe("Peugeot 9X8 optimised derivative", () => {
  let temporaryDirectory: string;
  let generatedPath: string;

  beforeAll(async () => {
    await MeshoptDecoder.ready;
    temporaryDirectory = await mkdtemp(join(tmpdir(), "raceiq-peugeot-"));
    generatedPath = join(temporaryDirectory, "peugeot_9x8_evo_2024_optimised.glb");
    await optimizePeugeotModel(sourcePath, generatedPath);
  });

  afterAll(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  test("preserves source and ships exterior-only meshopt derivative", async () => {
    const source = await readFile(sourcePath);
    const generated = await readFile(generatedPath);
    const root = (await createIO().readBinary(generated)).getRoot();
    const names = new Set(root.listNodes().map((node) => node.getName()));

    expect(createHash("sha256").update(source).digest("hex")).toBe(PEUGEOT_SOURCE_SHA256);
    expect(generated.byteLength).toBeLessThan(source.byteLength * 0.3);
    expect(root.listMaterials()).toHaveLength(0);
    expect(root.listTextures()).toHaveLength(0);
    expect(root.listExtensionsRequired().some((extension) => extension.extensionName === EXTMeshoptCompression.EXTENSION_NAME)).toBe(true);
    expect(names.has("BODY")).toBe(true);
    expect(names.has("GEO_BODY")).toBe(true);
    expect([...names].some((name) => name.startsWith("INT_") || name.startsWith("COCKPIT"))).toBe(false);

    for (const primitive of root.listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
      expect(primitive.listSemantics().sort()).toEqual(["JOINTS_0", "NORMAL", "POSITION", "WEIGHTS_0"].filter((semantic) => primitive.getAttribute(semantic)));
    }
  });
});
