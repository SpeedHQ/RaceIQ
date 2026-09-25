import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PEUGEOT_SOURCE_SHA256 = "5d3bfc73e3b071f3ba0cb5ce8ca52cfc38fa52d6320859ee6940f9bad6467e10";

const REMOVED_NODE_PREFIXES = [
  "COCKPIT",
  "STEER",
  "STEEER",
  "INT_",
  "__INT_",
  "DISPLAY2",
  "WIPER",
  "MIRROR_C",
  "RIM_BLUR_",
  "GEO_RIM_SBLUR_",
  "GEO_RIM_BLUR_",
] as const;

export interface PeugeotOptimizationReport {
  sourceBytes: number;
  outputBytes: number;
  sourceNodeCount: number;
  outputNodeCount: number;
  removedNodeNames: string[];
  materialCount: number;
  textureCount: number;
  imageCount: number;
}

function createIO(): NodeIO {
  return new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
}

export async function optimizePeugeotModel(inputPath: string, outputPath: string): Promise<PeugeotOptimizationReport> {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error("Input and output paths must differ");

  const sourceBytes = await readFile(input);
  if (createHash("sha256").update(sourceBytes).digest("hex") !== PEUGEOT_SOURCE_SHA256) {
    throw new Error(`Unexpected Peugeot source SHA-256 for ${input}`);
  }

  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = createIO();
  const document = await io.readBinary(sourceBytes);
  const root = document.getRoot();
  const sourceNodeCount = root.listNodes().length;
  const removedNodeNames: string[] = [];

  for (const node of root.listNodes()) {
    const name = node.getName();
    if (REMOVED_NODE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      removedNodeNames.push(name);
      node.dispose();
    }
  }

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

  return {
    sourceBytes: sourceBytes.byteLength,
    outputBytes: outputStat.size,
    sourceNodeCount,
    outputNodeCount: root.listNodes().length,
    removedNodeNames,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    imageCount: root.listTextures().filter((texture) => texture.getImage() !== null).length,
  };
}

if (import.meta.main) {
  const inputPath = process.argv[2] ?? resolve(REPO_ROOT, "assets/models/source/peugeot_9x8_evo_2024.glb");
  const outputPath = process.argv[3] ?? resolve(REPO_ROOT, "client/public/models/peugeot_9x8_evo_2024_optimised.glb");
  optimizePeugeotModel(inputPath, outputPath)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      console.log(`Reduced ${(100 * (1 - report.outputBytes / report.sourceBytes)).toFixed(2)}% (${report.sourceBytes} -> ${report.outputBytes} bytes)`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
