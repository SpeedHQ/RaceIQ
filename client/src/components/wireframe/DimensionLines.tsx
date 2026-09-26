import * as THREE from "three/webgpu";
import type { CarModelEnrichment } from "../../data/car-models";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { THREE_COLORS } from "../../lib/wireframe-utils";
import { createRibbonPool, disposeRibbonPool, updateRibbonPool, type RibbonPool } from "./LineResources";

type DimensionLabelResource = { sprite: THREE.Sprite; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; material: THREE.SpriteMaterial; text: string; color: string };
function createLabel(scene: THREE.Scene, position: [number, number, number], color: string): DimensionLabelResource {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 64;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) throw new Error("Unable to create 3D dimension label canvas");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material); sprite.position.set(...position); sprite.scale.set(1.2, 0.3, 1); scene.add(sprite);
  return { sprite, canvas, ctx, texture, material, text: "", color };
}
export type DimensionLineResource = { lines: RibbonPool[]; labels: DimensionLabelResource[] };
export function createDimensionLineResource(scene: THREE.Scene): DimensionLineResource {
  const lines = Array.from({ length: 8 }, () => createRibbonPool({ depthTest: false }));
  for (const line of lines) scene.add(line.group);
  return { lines, labels: [createLabel(scene, [0, 0, 0], "var(--app-accent)"), createLabel(scene, [0, 0, 0], "var(--app-accent)"), createLabel(scene, [0, 0, 0], "var(--dimension-secondary)")] };
}
export function updateDimensionLineResource(resource: DimensionLineResource, camera: THREE.PerspectiveCamera, carModel: CarModelEnrichment, viewportHeight: number): void {
  const wb = carModel.halfWheelbase, ft = carModel.halfFrontTrack, rt = carModel.halfRearTrack, y = -0.42;
  const accent = THREE_COLORS.appAccent, secondary = THREE_COLORS.dimensionSecondary;
  const lines: [number, number, number][][] = [
    [[wb,y,-ft],[wb,y,ft]], [[wb,y-0.05,-ft],[wb,y+0.05,-ft]], [[wb,y-0.05,ft],[wb,y+0.05,ft]],
    [[-wb,y,-rt],[-wb,y,rt]], [[-wb,y-0.05,-rt],[-wb,y+0.05,-rt]], [[-wb,y-0.05,rt],[-wb,y+0.05,rt]],
    [[wb,y,-ft],[-wb,y,-rt]], [[-wb,y-0.05,-rt],[-wb,y+0.05,-rt]],
  ];
  for (let i = 0; i < lines.length; i++) updateRibbonPool(resource.lines[i], camera, [lines[i].map(([x, py, z]) => ({ x, y: py, z, color: i < 6 ? accent : secondary }))], 2, viewportHeight);
  const labels = resource.labels, positions: [number,number,number][] = [[wb,y+0.15,0],[-wb,y+0.15,0],[0,y+0.15,-(ft+rt)/2]];
  const texts = [`${(ft*2000).toFixed(0)}mm`, `${(rt*2000).toFixed(0)}mm`, `${(wb*2000).toFixed(0)}mm`];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]; label.sprite.position.set(...positions[i]);
    if (label.text === texts[i]) continue;
    label.text = texts[i]; label.ctx.clearRect(0,0,256,64); label.ctx.font = "var(--font-weight-bold) var(--text-4xl) var(--font-mono)"; label.ctx.textAlign = "center"; label.ctx.textBaseline = "middle"; label.ctx.fillStyle = label.color; label.ctx.fillText(texts[i],128,32); label.texture.needsUpdate = true;
  }
}
export function disposeDimensionLineResource(resource: DimensionLineResource): void {
  for (const line of resource.lines) { disposeRibbonPool(line); line.group.removeFromParent(); }
  for (const label of resource.labels) { label.sprite.removeFromParent(); label.material.dispose(); label.texture.dispose(); }
}
