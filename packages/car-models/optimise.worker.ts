import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { shrink, type ShrinkOptions } from "./shrink";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

self.onmessage = async ({ data: { file, options } }: MessageEvent<{ file: Blob; options: ShrinkOptions }>) => {
  try {
    if (!file.size || file.size > 64 * 1024 * 1024) throw Error();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
    const view = new DataView(bytes.buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a) throw Error();
    const jsonLength = view.getUint32(12, true);
    if (jsonLength > 8 * 1024 * 1024 || 20 + jsonLength > bytes.length) throw Error();
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    if (
      !json.buffers?.length ||
      json.buffers.some(
        (b: { uri?: string; extensions?: { EXT_meshopt_compression?: { fallback?: boolean } } }, i: number) => b.uri !== undefined || (i > 0 && !b.extensions?.EXT_meshopt_compression?.fallback),
      ) ||
      json.images?.some((i: { uri?: string }) => i.uri !== undefined)
    )
      throw Error();
    const views = json.bufferViews ?? [];
    let expandedBytes = 0;
    for (const view of views) {
      if (!Number.isSafeInteger(view.byteLength) || view.byteLength < 0) throw Error();
      const compression = view.extensions?.EXT_meshopt_compression;
      if (
        compression &&
        (!Number.isSafeInteger(compression.count) ||
          !Number.isSafeInteger(compression.byteStride) ||
          compression.count < 0 ||
          compression.byteStride < 1 ||
          compression.count * compression.byteStride !== view.byteLength)
      )
        throw Error();
      expandedBytes += view.byteLength;
    }
    if (expandedBytes > 256 * 1024 * 1024) throw Error();
    let unpacked = 0;
    const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    for (const accessor of json.accessors ?? []) {
      if (!Number.isSafeInteger(accessor.count) || accessor.count < 0) throw Error();
      unpacked += accessor.count * (components[accessor.type] ?? Infinity) * 4;
    }
    if (!Number.isFinite(unpacked) || unpacked > 256 * 1024 * 1024) throw Error();
    if ((json.extensionsUsed ?? []).some((name: string) => !ALL_EXTENSIONS.some((ext) => ext.EXTENSION_NAME === name))) throw Error();
    await MeshoptDecoder.ready;
    const doc = await io.readBinary(bytes);
    const root = doc.getRoot();
    if (
      !root.listScenes().some((scene) => {
        let visible = false;
        scene.traverse((node) => {
          visible ||= !!node
            .getMesh()
            ?.listPrimitives()
            .some((p) => (p.getAttribute("POSITION")?.getCount() ?? 0) >= 3);
        });
        return visible;
      })
    )
      throw Error();
    const parts = root
      .listNodes()
      .map((node, index) => ({ index, name: node.getName() || node.getMesh()?.getName() || "#" + (index + 1), mesh: !!node.getMesh() }))
      .filter((node) => node.mesh);
    await shrink(doc, options);
    if (
      !root.listScenes().some((scene) => {
        let visible = false;
        scene.traverse((node) => {
          visible ||= !!node.getMesh()?.listPrimitives().length;
        });
        return visible;
      })
    )
      throw Error();
    for (const texture of root.listTextures()) {
      const size = texture.getSize();
      if (!size || size[0] * size[1] > 32 * 1024 * 1024) throw Error();
      if (!options.textureLimit || Math.max(...size) <= options.textureLimit) continue;
      const ratio = options.textureLimit / Math.max(...size);
      const image = texture.getImage();
      if (!image) throw Error();
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(size[0] * ratio)), Math.max(1, Math.round(size[1] * ratio)));
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: texture.getMimeType() }), { resizeWidth: canvas.width, resizeHeight: canvas.height });
      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw Error();
        ctx.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      const blob = await canvas.convertToBlob({ type: texture.getMimeType() });
      texture.setImage(new Uint8Array(await blob.arrayBuffer())).setMimeType(blob.type);
    }
    self.postMessage({ blob: new Blob([new Uint8Array(await io.writeBinary(doc))], { type: "model/gltf-binary" }), parts });
  } catch {
    self.postMessage(null);
  }
};
