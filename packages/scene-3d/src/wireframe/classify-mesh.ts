// Pure mesh classification — no Three.js / drei imports so this module
// can be loaded from Node/Bun test runners without touching WebGL.

export const DEFAULT_HIDDEN_MESHES = new Set([94, 125, 126, 161, 183, 184, 211, 212, 214, 215, 217, 219, 119, 120, 122, 123, 174, 175, 177, 178, 7, 8]);

/**
 * Determine what action to take for a mesh given current display mode.
 * Returns "remove" | "solid" | "wire" to indicate the mesh treatment.
 */
export function classifyMesh(meshName: string, solid: "wire" | "solid" | "hidden", hideModelWheels: boolean, customHiddenMeshes?: number[]): "remove" | "solid" | "wire" {
  const hiddenMeshes = customHiddenMeshes?.length ? new Set(customHiddenMeshes) : DEFAULT_HIDDEN_MESHES;
  const num = parseInt(meshName.replace(/\D/g, ""), 10);
  const isWheelMesh = hiddenMeshes.has(num);

  if (solid === "hidden") return "remove";
  if (isWheelMesh && (solid === "solid" || hideModelWheels)) return "remove";
  if (solid === "solid") return "solid";
  return "wire";
}
