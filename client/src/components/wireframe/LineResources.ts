import * as THREE from "three/webgpu";
import { color as tslColor, float, positionWorld, vec4 } from "three/tsl";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { Line2NodeMaterial } from "three/webgpu";

export type LinePoint = { x: number; y: number; z: number; color?: THREE.ColorRepresentation; alpha?: number };
export type RibbonRun = readonly LinePoint[];
type OpaqueState = { capacity: number; start: Float32Array; end: Float32Array; startAttribute: THREE.InstancedBufferAttribute; endAttribute: THREE.InstancedBufferAttribute };
const lineState = new WeakMap<Line2, OpaqueState>();
/** Retained WebGPU wide opaque line. */
export function createOpaqueWideLine(color: THREE.ColorRepresentation, width: number): Line2 {
  const geometry = new LineGeometry();
  const line = new Line2(geometry, new Line2NodeMaterial({ color, linewidth: width, worldUnits: false }));
  lineState.set(line, { capacity: 0, start: new Float32Array(), end: new Float32Array(), startAttribute: new THREE.InstancedBufferAttribute(new Float32Array(), 3), endAttribute: new THREE.InstancedBufferAttribute(new Float32Array(), 3) });
  return line;
}
/** Mutates retained instance buffers; grows capacity geometrically only when needed. */
export function updateOpaqueWideLine(line: Line2, points: readonly THREE.Vector3[]): void {
  const state = lineState.get(line)!;
  const geometry = line.geometry as LineGeometry;
  if (points.length < 2) { geometry.instanceCount = 0; line.visible = false; return; }
  const segments = points.length - 1;
  if (segments > state.capacity) {
    state.capacity = 2 ** Math.ceil(Math.log2(segments));
    state.start = new Float32Array(state.capacity * 3); state.end = new Float32Array(state.capacity * 3);
    state.startAttribute = new THREE.InstancedBufferAttribute(state.start, 3).setUsage(THREE.DynamicDrawUsage);
    state.endAttribute = new THREE.InstancedBufferAttribute(state.end, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("instanceStart", state.startAttribute); geometry.setAttribute("instanceEnd", state.endAttribute);
  }
  for (let i = 0; i < segments; i++) {
    const a = points[i], b = points[i + 1], k = i * 3;
    state.start[k] = a.x; state.start[k + 1] = a.y; state.start[k + 2] = a.z;
    state.end[k] = b.x; state.end[k + 1] = b.y; state.end[k + 2] = b.z;
  }
  state.startAttribute.needsUpdate = true; state.endAttribute.needsUpdate = true;
  geometry.instanceCount = segments;
  if (!geometry.boundingBox) geometry.boundingBox = new THREE.Box3();
  geometry.boundingBox.makeEmpty();
  for (let i = 0; i < points.length; i++) geometry.boundingBox.expandByPoint(points[i]);
  if (!geometry.boundingSphere) geometry.boundingSphere = new THREE.Sphere();
  geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
  line.visible = true;
}
export function disposeOpaqueWideLine(line: Line2): void { lineState.delete(line); line.geometry.dispose(); line.material.dispose(); }

type Slot = { geometry: THREE.BufferGeometry; mesh: THREE.Mesh; capacity: number; positions: Float32Array; colors: Float32Array; indices: Uint32Array; bounds: THREE.Box3; sphere: THREE.Sphere };
type WorkPoint = { x: number; y: number; z: number; color: THREE.Color; alpha: number };
export type RibbonPool = { group: THREE.Group; slots: Slot[]; material: THREE.MeshBasicMaterial; disposed: boolean; workRuns: WorkPoint[][] };
export function createRibbonPool(options: { opacity?: number; depthTest?: boolean } = {}): RibbonPool {
  return { group: new THREE.Group(), slots: [], material: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: options.opacity ?? 1, depthWrite: false, depthTest: options.depthTest ?? true, side: THREE.DoubleSide }), disposed: false, workRuns: [] };
}
function ensureSlot(pool: RibbonPool, index: number, count: number): Slot {
  let s = pool.slots[index];
  if (!s) {
    const geometry = new THREE.BufferGeometry(), mesh = new THREE.Mesh(geometry, pool.material);
    mesh.frustumCulled = false; pool.group.add(mesh);
    s = pool.slots[index] = { geometry, mesh, capacity: 0, positions: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(), bounds: new THREE.Box3(), sphere: new THREE.Sphere() };
  }
  if (count > s.capacity) {
    // WebGPU render bundles retain index buffer bindings for rendered geometry.
    // Replacing index attribute in place can leave sibling ribbons with stale bindings.
    const previous = s.geometry;
    s.geometry = new THREE.BufferGeometry();
    s.mesh.geometry = s.geometry;
    previous.dispose();
    s.capacity = 2 ** Math.ceil(Math.log2(count));
    const strips = s.capacity * 2, capVertices = 20;
    s.positions = new Float32Array((strips + capVertices) * 3); s.colors = new Float32Array((strips + capVertices) * 4);
    s.indices = new Uint32Array((s.capacity - 1) * 6 + 48);
    for (let i = 0; i < s.capacity - 1; i++) { const a = i * 2; s.indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6); }
    s.geometry.setAttribute("position", new THREE.BufferAttribute(s.positions, 3).setUsage(THREE.DynamicDrawUsage));
    s.geometry.setAttribute("color", new THREE.BufferAttribute(s.colors, 4).setUsage(THREE.DynamicDrawUsage));
    s.geometry.setIndex(new THREE.BufferAttribute(s.indices, 1));
  }
  return s;
}
const scratchView = new THREE.Vector3(), scratchRight = new THREE.Vector3(), scratchUp = new THREE.Vector3();
const scratchCur = new THREE.Vector3(), scratchPrev = new THREE.Vector3(), scratchNext = new THREE.Vector3();
const scratchTangent = new THREE.Vector3(), scratchSide = new THREE.Vector3(), scratchIncoming = new THREE.Vector3(), scratchOutgoing = new THREE.Vector3();
const scratchMiter = new THREE.Vector3(), scratchOffset = new THREE.Vector3(), scratchRadial = new THREE.Vector3();
const scratchColor = new THREE.Color(), scratchColor2 = new THREE.Color();
/** Retained camera-facing pixel ribbons. Near-plane crossings split independent visible strips. */
export function updateRibbonPool(pool: RibbonPool, camera: THREE.PerspectiveCamera, runs: readonly RibbonRun[], width: number, viewportHeight: number): void {
  if (pool.disposed) return;
  camera.updateMatrixWorld();
  const view = scratchView.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const right = scratchRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = scratchUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / camera.zoom;
  let active = 0;
  const process = (points: WorkPoint[], count: number) => {
    if (count < 2) return;
    const slot = ensureSlot(pool, active++, count), capN = 8;
    let indexCount = 0;
    for (let i = 0; i < count; i++) {
      const p = points[i], prev = points[i ? i - 1 : 0], next = points[i + 1 < count ? i + 1 : count - 1];
      scratchCur.set(p.x, p.y, p.z); scratchPrev.set(prev.x, prev.y, prev.z); scratchNext.set(next.x, next.y, next.z);
      scratchTangent.subVectors(scratchNext, scratchPrev).normalize();
      scratchSide.crossVectors(scratchTangent, view).normalize();
      if (scratchSide.lengthSq() < 1e-8) scratchSide.copy(right);
      if (i && i < count - 1) {
        scratchIncoming.subVectors(scratchCur, scratchPrev).normalize();
        scratchOutgoing.subVectors(scratchNext, scratchCur).normalize();
        scratchMiter.addVectors(scratchIncoming, scratchOutgoing).normalize().cross(view).normalize();
        const scale = Math.min(2, 1 / Math.max(0.5, Math.abs(scratchMiter.dot(scratchSide))));
        scratchSide.copy(scratchMiter).multiplyScalar(scale);
      }
      const depth = Math.max(camera.near, scratchCur.sub(camera.position).dot(view));
      scratchOffset.copy(scratchSide).multiplyScalar(width * depth * halfFov / viewportHeight);
      const k = i * 2 * 3, c = i * 2 * 4, col = p.color, a = p.alpha;
      slot.positions[k] = p.x + scratchOffset.x; slot.positions[k + 1] = p.y + scratchOffset.y; slot.positions[k + 2] = p.z + scratchOffset.z;
      slot.positions[k + 3] = p.x - scratchOffset.x; slot.positions[k + 4] = p.y - scratchOffset.y; slot.positions[k + 5] = p.z - scratchOffset.z;
      for (let side = 0; side < 2; side++) { const ci = c + side * 4; slot.colors[ci] = col.r; slot.colors[ci + 1] = col.g; slot.colors[ci + 2] = col.b; slot.colors[ci + 3] = a; }
      if (i < count - 1) {
        const q = i * 2, ix = indexCount;
        slot.indices[ix] = q; slot.indices[ix + 1] = q + 1; slot.indices[ix + 2] = q + 2;
        slot.indices[ix + 3] = q + 1; slot.indices[ix + 4] = q + 3; slot.indices[ix + 5] = q + 2;
        indexCount += 6;
      }
    }
    const capBase = slot.capacity * 2;
    for (let end = 0; end < 2; end++) {
      const p = points[end ? count - 1 : 0], depth = Math.max(camera.near, scratchCur.set(p.x, p.y, p.z).sub(camera.position).dot(view));
      const radius = width * depth * halfFov / viewportHeight, base = capBase + end * 10, col = p.color;
      const center = base * 3, centerColor = base * 4;
      slot.positions[center] = p.x; slot.positions[center + 1] = p.y; slot.positions[center + 2] = p.z;
      slot.colors[centerColor] = col.r; slot.colors[centerColor + 1] = col.g; slot.colors[centerColor + 2] = col.b; slot.colors[centerColor + 3] = p.alpha;
      for (let j = 0; j < capN; j++) {
        const angle = j * Math.PI * 2 / capN;
        scratchRadial.copy(right).multiplyScalar(Math.cos(angle)).addScaledVector(up, Math.sin(angle)).multiplyScalar(radius);
        const v = base + 1 + j, k = v * 3, c = v * 4;
        slot.positions[k] = p.x + scratchRadial.x; slot.positions[k + 1] = p.y + scratchRadial.y; slot.positions[k + 2] = p.z + scratchRadial.z;
        slot.colors[c] = col.r; slot.colors[c + 1] = col.g; slot.colors[c + 2] = col.b; slot.colors[c + 3] = p.alpha;
        const ix = indexCount;
        slot.indices[ix] = base; slot.indices[ix + 1] = base + 1 + j; slot.indices[ix + 2] = base + 1 + (j + 1) % capN;
        indexCount += 3;
      }
    }
    (slot.geometry.index as THREE.BufferAttribute).needsUpdate = true;
    (slot.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (slot.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    slot.geometry.setDrawRange(0, indexCount);
    slot.bounds.makeEmpty();
    const activeVertices = count * 2, capStart = slot.capacity * 2;
    for (let i = 0; i < activeVertices; i++) { const k = i * 3; scratchCur.set(slot.positions[k], slot.positions[k + 1], slot.positions[k + 2]); slot.bounds.expandByPoint(scratchCur); }
    for (let i = 0; i < 20; i++) { const k = (capStart + i) * 3; scratchCur.set(slot.positions[k], slot.positions[k + 1], slot.positions[k + 2]); slot.bounds.expandByPoint(scratchCur); }
    slot.bounds.getBoundingSphere(slot.sphere);
    slot.geometry.boundingBox = slot.bounds; slot.geometry.boundingSphere = slot.sphere;
    slot.mesh.visible = true;
  };
  const point = (array: WorkPoint[], index: number): WorkPoint => {
    while (array.length <= index) array.push({ x: 0, y: 0, z: 0, color: new THREE.Color(), alpha: 1 });
    return array[index];
  };
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]; let scratch = pool.workRuns[r];
    if (!scratch) pool.workRuns[r] = scratch = [];
    let count = 0;
    for (let i = 0; i < run.length; i++) {
      const p = run[i], depth = scratchCur.set(p.x, p.y, p.z).sub(camera.position).dot(view), inside = depth >= camera.near;
      if (i) {
        const prev = run[i - 1], prevDepth = scratchCur.set(prev.x, prev.y, prev.z).sub(camera.position).dot(view), wasInside = prevDepth >= camera.near;
        if (inside !== wasInside) {
          const t = (camera.near - prevDepth) / (depth - prevDepth), out = point(scratch, count++);
          out.x = prev.x + (p.x - prev.x) * t; out.y = prev.y + (p.y - prev.y) * t; out.z = prev.z + (p.z - prev.z) * t;
          scratchColor.set(prev.color ?? 0xffffff); scratchColor2.set(p.color ?? prev.color ?? 0xffffff);
          out.color.copy(scratchColor).lerp(scratchColor2, t); out.alpha = (prev.alpha ?? 1) + ((p.alpha ?? 1) - (prev.alpha ?? 1)) * t;
          if (!inside) { process(scratch, count); count = 0; }
        }
      }
      if (inside) {
        const out = point(scratch, count++);
        out.x = p.x; out.y = p.y; out.z = p.z; out.color.set(p.color ?? 0xffffff); out.alpha = p.alpha ?? 1;
      }
    }
    process(scratch, count);
  }
  for (let i = active; i < pool.slots.length; i++) { pool.slots[i].geometry.setDrawRange(0, 0); pool.slots[i].mesh.visible = false; }
}
export function disposeRibbonPool(pool: RibbonPool): void {
  if (pool.disposed) return;
  pool.disposed = true;
  for (const s of pool.slots) { pool.group.remove(s.mesh); s.geometry.dispose(); }
  pool.slots.length = 0; pool.workRuns.length = 0; pool.material.dispose();
}

export type RetainedGrid = { group: THREE.Group; minor: THREE.LineSegments; major: THREE.LineSegments; updatePose(x: number, z: number, yaw: number): void; resetPose(): void; dispose(): void };
/** Finite 1-metre grid with 2-metre accents and stationary 8-unit fade. */
export function createRetainedGrid(size = 24): RetainedGrid {
  const group = new THREE.Group();
  const make = (step: number, tint: number, opacity: number) => {
    const positions: number[] = [];
    for (let x = -size / 2; x <= size / 2 + 1e-6; x += step) {
      // Coincident minor/major segments z-fight as grid moves across pixels.
      if (step < 2 && Math.abs(x % 2) < 1e-6) continue;
      positions.push(x, 0, -size / 2, x, 0, size / 2, -size / 2, 0, x, size / 2, 0, x);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicNodeMaterial({ color: tint, transparent: true, opacity, depthWrite: false });
    material.colorNode = vec4(tslColor(tint), float(1).sub(positionWorld.xz.length().smoothstep(0, 8)));
    const mesh = new THREE.LineSegments(geometry, material); group.add(mesh); return mesh;
  };
  const minor = make(1, 0x30343a, 0.65), major = make(2, 0x51565e, 0.8);
  return {
    group, minor, major,
    updatePose(x, z, yaw) {
      // World lattice stays fixed while car turns; reduce world coordinates before
      // rotating so distant track origins cannot amplify yaw into grid motion.
      const worldX = x % 2, worldZ = z % 2;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      group.rotation.y = yaw;
      group.position.set(-(worldX * sin + worldZ * cos), -0.45, -(worldX * cos - worldZ * sin));
    },
    resetPose() { group.position.set(0, -0.45, 0); group.rotation.y = 0; },
    dispose() { for (const mesh of [minor, major]) { mesh.geometry.dispose(); mesh.material.dispose(); } group.clear(); },
  };
}
