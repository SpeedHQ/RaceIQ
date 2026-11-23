import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { shrink } from "./shrink";
import { REMOVED_GT3_NODE_NAMES, REMOVED_NODE_PREFIXES } from "./shipped-parts";
export { REMOVED_GT3_NODE_NAMES } from "./shipped-parts";

export const F1_SOURCE_SHA256 = "51485dc78941018ff6ee9211aed3e609a70513615c12762835d43271e81abf19";
export const GT3_SOURCE_SHA256 = "35c3a9752262a5c912e85f1e990bb6a7ac16dfd2923b19191aafc907e3a99e3d";
export const PEUGEOT_SOURCE_SHA256 = "5d3bfc73e3b071f3ba0cb5ce8ca52cfc38fa52d6320859ee6940f9bad6467e10";
const hashes = { f1: F1_SOURCE_SHA256, gt3: GT3_SOURCE_SHA256, peugeot: PEUGEOT_SOURCE_SHA256 };
export async function shrinkShipped(model: keyof typeof hashes, inputPath: string, outputPath: string) {
  const input = resolve(inputPath),
    output = resolve(outputPath);
  if (input === output) throw new Error("Input and output paths must differ");
  const bytes = await readFile(input);
  if (createHash("sha256").update(bytes).digest("hex") !== hashes[model]) throw new Error("Unexpected source SHA-256 for " + input);
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const document = await io.readBinary(bytes);
  const root = document.getRoot(),
    nodes = root.listNodes();
  const remove =
    model === "gt3"
      ? REMOVED_GT3_NODE_NAMES.map((name) => {
          const index = nodes.findIndex((node) => node.getName() === name);
          if (index < 0) throw new Error("Required GT3 node missing: " + name);
          return index;
        })
      : model === "peugeot"
        ? nodes.flatMap((node, index) => (REMOVED_NODE_PREFIXES.some((prefix) => node.getName().startsWith(prefix)) ? [index] : []))
        : [];
  const removedNodeNames = remove.map((index) => nodes[index]!.getName());
  await shrink(document, { replayOnly: true, remove, textureLimit: 0 });
  const encoded = await io.writeBinary(document);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded);
  const vertexCount = root
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, p) => total + (p.getAttribute("POSITION")?.getCount() ?? 0), 0);
  return {
    sourceBytes: bytes.length,
    outputBytes: encoded.length,
    sourceNodeCount: nodes.length,
    outputNodeCount: root.listNodes().length,
    removedNodeNames,
    vertexCount,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    imageCount: root.listTextures().filter((t) => t.getImage() !== null).length,
  };
}
