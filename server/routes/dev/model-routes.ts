import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const MODELS = {
  gt3: {
    sourcePath: resolve("assets/models/source/aston_martin_vantage_gt3.glb"),
    optimizedPath: resolve("client/public/models/aston_martin_vantage_gt3_exterior.glb"),
  },
  f1: {
    sourcePath: resolve("assets/models/source/f1_2025_mclaren_mcl39.glb"),
    optimizedPath: resolve("client/public/models/f1_2025_mclaren_mcl39_exterior.glb"),
  },
} as const;

type ModelId = keyof typeof MODELS;

const io = new NodeIO()
  .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

async function modelStats(path: string) {
  const [file, fileStat] = await Promise.all([readFile(path), stat(path)]);
  const document = await io.readBinary(file);
  const vertexCount = document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, primitive) => total + (primitive.getAttribute("POSITION")?.getCount() ?? 0), 0);
  return { sizeBytes: fileStat.size, vertexCount };
}

function getModel(id: string): (typeof MODELS)[ModelId] | null {
  return id in MODELS ? MODELS[id as ModelId] : null;
}

export const modelRoutes = new Hono()
  .get("/api/dev/models/:modelId", async (c) => {
    const model = getModel(c.req.param("modelId"));
    if (!model) return c.json({ error: "Unknown model" }, 404);
    const [original, optimized] = await Promise.all([modelStats(model.sourcePath), modelStats(model.optimizedPath)]);
    return c.json({ original, optimized });
  })
  .get("/api/dev/models/:modelId/original", async (c) => {
    const model = getModel(c.req.param("modelId"));
    if (!model) return c.json({ error: "Unknown model" }, 404);
    const bytes = await readFile(model.sourcePath);
    return new Response(bytes, {
      headers: {
        "Content-Type": "model/gltf-binary",
        "Cache-Control": "no-store",
      },
    });
  });
