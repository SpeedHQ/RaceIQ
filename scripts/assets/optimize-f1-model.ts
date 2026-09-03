import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const F1_SOURCE_SHA256 = "51485dc78941018ff6ee9211aed3e609a70513615c12762835d43271e81abf19";

export interface F1OptimizationReport {
  sourceBytes: number;
  outputBytes: number;
  vertexCount: number;
  materialCount: number;
  textureCount: number;
  imageCount: number;
}

export async function optimizeF1Model(inputPath: string, outputPath: string): Promise<F1OptimizationReport> {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error("Input and output paths must differ");
  const sourceBytes = await readFile(input);
  if (createHash("sha256").update(sourceBytes).digest("hex") !== F1_SOURCE_SHA256) throw new Error(`Unexpected F1 source SHA-256 for ${input}`);
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const document = await io.readBinary(sourceBytes);
  const root = document.getRoot();
  for (const primitive of root.listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
    primitive.setMaterial(null);
    for (const semantic of primitive.listSemantics()) {
      if (semantic === "POSITION" || semantic === "NORMAL" || semantic === "JOINTS_0" || semantic === "WEIGHTS_0") continue;
      primitive.setAttribute(semantic, null);
    }
  }
  await document.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: "medium", quantizePosition: 16 }));
  document.createExtension(EXTMeshoptCompression).setRequired(true);
  await mkdir(dirname(output), { recursive: true });
  const encoded = await io.writeBinary(document);
  await writeFile(output, encoded);
  const outputStat = await stat(output);
  const vertexCount = root.listMeshes().flatMap((mesh) => mesh.listPrimitives()).reduce((total, primitive) => total + (primitive.getAttribute("POSITION")?.getCount() ?? 0), 0);
  return {
    sourceBytes: sourceBytes.byteLength,
    outputBytes: outputStat.size,
    vertexCount,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    imageCount: root.listTextures().filter((texture) => texture.getImage() !== null).length,
  };
}

if (import.meta.main) {
  const inputPath = process.argv[2] ?? resolve(REPO_ROOT, "assets/models/source/f1_2025_mclaren_mcl39.glb");
  const outputPath = process.argv[3] ?? resolve(REPO_ROOT, "client/public/models/f1_2025_mclaren_mcl39_optimised.glb");
  try {
    const report = await optimizeF1Model(inputPath, outputPath);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Reduced ${(100 * (1 - report.outputBytes / report.sourceBytes)).toFixed(2)}% (${report.sourceBytes} -> ${report.outputBytes} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
