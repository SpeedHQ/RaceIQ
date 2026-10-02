import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { optimizeF1Model, F1_SOURCE_SHA256 } from "../../scripts/assets/optimize-f1-model";
import { MeshoptDecoder } from "meshoptimizer";

const sourcePath = resolve("assets/models/source/f1_2025_mclaren_mcl39.glb");

describe("F1 optimised derivative", () => {
  let temporaryDirectory: string;
  let generatedPath: string;

  beforeAll(async () => {
    await MeshoptDecoder.ready;
    temporaryDirectory = await mkdtemp(join(tmpdir(), "raceiq-f1-"));
    generatedPath = join(temporaryDirectory, "f1_2025_mclaren_mcl39_optimised.glb");
    await optimizeF1Model(sourcePath, generatedPath);
  });

  afterAll(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  test("preserves source and strips unused material data", async () => {
    const source = await readFile(sourcePath);
    const output = await readFile(generatedPath);
    const io = new NodeIO().registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
    const document = await io.readBinary(output);
    const root = document.getRoot();
    expect(createHash("sha256").update(source).digest("hex")).toBe(F1_SOURCE_SHA256);
    expect(output.byteLength).toBeLessThan(source.byteLength * 0.3);
    expect(root.listMaterials()).toHaveLength(0);
    expect(root.listTextures()).toHaveLength(0);
    expect(root.listExtensionsRequired().some((extension) => extension.extensionName === EXTMeshoptCompression.EXTENSION_NAME)).toBe(true);
    expect(root.listNodes().map((node) => node.getName())).toContain("main_body_6");
    for (const primitive of root.listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
      expect(primitive.listSemantics().sort()).toEqual(["JOINTS_0", "NORMAL", "POSITION", "WEIGHTS_0"].filter((semantic) => primitive.getAttribute(semantic)));
    }
  });
});
