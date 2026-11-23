import { type Document } from "@gltf-transform/core";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

export interface ShrinkOptions {
  replayOnly: boolean;
  remove: readonly number[];
  textureLimit: number;
}
export async function shrink(document: Document, options: ShrinkOptions) {
  const root = document.getRoot();
  const nodes = root.listNodes();
  for (const index of options.remove) nodes[index]!.dispose();
  if (options.replayOnly)
    for (const mesh of root.listMeshes())
      for (const primitive of mesh.listPrimitives()) {
        primitive.setMaterial(null);
        for (const semantic of primitive.listSemantics()) if (!["POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0"].includes(semantic)) primitive.setAttribute(semantic, null);
      }
  await MeshoptEncoder.ready;
  await document.transform(
    dedup(),
    prune(options.replayOnly ? {} : { keepAttributes: true, keepLeaves: true, keepSolidTextures: true }),
    meshopt({ encoder: MeshoptEncoder, level: "medium", quantizePosition: 16 }),
  );
}
