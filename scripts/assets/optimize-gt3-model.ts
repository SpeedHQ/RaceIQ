import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const GT3_SOURCE_SHA256 = "35c3a9752262a5c912e85f1e990bb6a7ac16dfd2923b19191aafc907e3a99e3d";

export const REMOVED_GT3_NODE_NAMES = [
  "SM_Aston_Martin_Vantage_GT3_Cockpit_Console_59",
  "SM_Aston_Martin_Vantage_GT3_Engine_Components_62",
  "SM_Aston_Martin_Vantage_GT3_Interior_71",
  "SM_Aston_Martin_Vantage_GT3_Net_73",
  "SM_Aston_Martin_Vantage_GT3_Pedals_Accelerate_74",
  "SM_Aston_Martin_Vantage_GT3_Pedals_Brake_75",
  "SM_Aston_Martin_Vantage_GT3_Pedals_Clutch_76",
  "SM_Aston_Martin_Vantage_GT3_Seat_85",
  "SM_Aston_Martin_Vantage_GT3_Seatbelt_86",
  "SM_Aston_Martin_Vantage_GT3_Steering_Wheel_87",
  "Object_80",
  "Object_81",
  "Object_82",
  "Object_88",
  "Object_89",
  "Object_90",
  "Object_137",
] as const;

export interface OptimizationReport {
  sourceBytes: number;
  outputBytes: number;
  sourceNodeCount: number;
  outputNodeCount: number;
  removedNodeNames: string[];
  materialCount: number;
  textureCount: number;
  imageCount: number;
}

function sourceHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createIO(): NodeIO {
  return new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
}

export async function optimizeGt3Model(inputPath: string, outputPath: string): Promise<OptimizationReport> {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error("Input and output paths must differ");

  const sourceBytes = await readFile(input);
  if (sourceHash(sourceBytes) !== GT3_SOURCE_SHA256) {
    throw new Error(`Unexpected GT3 source SHA-256 for ${input}`);
  }

  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = createIO();
  const document = await io.readBinary(sourceBytes);
  const root = document.getRoot();
  const sourceNodeCount = root.listNodes().length;
  const nodesByName = new Map<string, ReturnType<typeof root.listNodes>[number]>();
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (name) nodesByName.set(name, node);
  }

  for (const name of REMOVED_GT3_NODE_NAMES) {
    const node = nodesByName.get(name);
    if (!node) throw new Error(`Required GT3 node missing: ${name}`);
    node.dispose();
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
    removedNodeNames: [...REMOVED_GT3_NODE_NAMES],
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    imageCount: root.listTextures().filter((texture) => texture.getImage() !== null).length,
  };
}

if (import.meta.main) {
  const inputPath = process.argv[2] ?? resolve(REPO_ROOT, "assets/models/source/aston_martin_vantage_gt3.glb");
  const outputPath = process.argv[3] ?? resolve(REPO_ROOT, "client/public/models/aston_martin_vantage_gt3_exterior.glb");
  try {
    const report = await optimizeGt3Model(inputPath, outputPath);
    const reduction = 1 - report.outputBytes / report.sourceBytes;
    console.log(JSON.stringify(report, null, 2));
    console.log(`Reduced ${(reduction * 100).toFixed(2)}% (${report.sourceBytes} -> ${report.outputBytes} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
