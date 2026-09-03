import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";
import { GT3_SOURCE_SHA256, optimizeGt3Model, REMOVED_GT3_NODE_NAMES } from "../../scripts/assets/optimize-gt3-model";

const sourcePath = resolve("assets/models/source/aston_martin_vantage_gt3.glb");
const retainedAssemblies = [
  "SM_Aston_Martin_Vantage_GT3_Main_Body_72",
  "SM_Aston_Martin_Vantage_GT3_Front_Bumper_64",
  "SM_Aston_Martin_Vantage_GT3_Rear_Bumper_79",
  "SM_Aston_Martin_Vantage_GT3_Rear_Diffuser_80",
  "SM_Aston_Martin_Vantage_GT3_Rear_Spoiler_83",
  "SM_Aston_Martin_Vantage_GT3_Wing_Mirror_Left_88",
  "SM_Aston_Martin_Vantage_GT3_Wing_Mirror_Right_89",
  "SM_Aston_Martin_Vantage_GT3_Wiper_90",
  "Object_209",
];

function createIO(): NodeIO {
  return new NodeIO().registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bounds(document: Awaited<ReturnType<NodeIO["read"]>>): number[][] {
  const scene = document.getRoot().listScenes()[0];
  const result = getBounds(scene);
  return [result.min, result.max];
}

describe("GT3 exterior derivative", () => {
  let temporaryDirectory: string;
  let generatedPath: string;

  beforeAll(async () => {
    await Promise.all([MeshoptDecoder.ready]);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "raceiq-gt3-"));
    generatedPath = join(temporaryDirectory, "aston_martin_vantage_gt3_exterior.glb");
    await optimizeGt3Model(sourcePath, generatedPath);
  });

  afterAll(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test("preserves source and generates the complete exterior contract", async () => {
    const source = await readFile(sourcePath);
    const generated = await readFile(generatedPath);
    const document = await createIO().readBinary(generated);
    const root = document.getRoot();
    const names = new Set(root.listNodes().map((node) => node.getName()));

    expect(hash(source)).toBe(GT3_SOURCE_SHA256);
    expect(hash(await readFile(sourcePath))).toBe(GT3_SOURCE_SHA256);
    expect(generated.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(generated.byteLength).toBeLessThanOrEqual(source.byteLength * 0.3);
    expect(REMOVED_GT3_NODE_NAMES.every((name) => !names.has(name))).toBe(true);
    expect(retainedAssemblies.every((name) => names.has(name))).toBe(true);
    expect(root.listMaterials()).toHaveLength(0);
    expect(root.listTextures()).toHaveLength(0);
    expect(root.listTextures().filter((texture) => texture.getImage() !== null)).toHaveLength(0);
    expect(root.listExtensionsRequired().some((extension) => extension.extensionName === EXTMeshoptCompression.EXTENSION_NAME)).toBe(true);

    for (const primitive of root.listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
      expect(primitive.listSemantics().sort()).toEqual(["JOINTS_0", "NORMAL", "POSITION", "WEIGHTS_0"].filter((semantic) => primitive.getAttribute(semantic)));
    }
  });

  test("keeps whole-scene bounds within one millimetre", async () => {
    const sourceDocument = await createIO().read(sourcePath);
    const generatedDocument = await createIO().read(generatedPath);
    for (const name of REMOVED_GT3_NODE_NAMES) {
      sourceDocument.getRoot().listNodes().find((node) => node.getName() === name)?.dispose();
    }
    const sourceBounds = bounds(sourceDocument);
    const generatedBounds = bounds(generatedDocument);
    for (let side = 0; side < 2; side++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs(sourceBounds[side][axis] - generatedBounds[side][axis])).toBeLessThanOrEqual(0.2);
      }
    }
  });
});
