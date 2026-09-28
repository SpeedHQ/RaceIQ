import * as THREE from "three/webgpu";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { createWheelLabelRefreshPolicy, type WheelLabelRefreshPolicy } from "../../lib/wheel-label-refresh";
import { brakeTempColor, tirePressureColor, tireTempColor } from "../../lib/vehicle-dynamics";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { severityRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";

const CARD_W = 320, ROW_H = 36, SCALE = 2;
const worldPosition = new THREE.Vector3();
function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.8);
  ctx.bezierCurveTo(x, y + size * 0.3, x - size, y + size * 0.3, x - size, y - size * 0.2);
  ctx.bezierCurveTo(x - size, y - size * 0.8, x - size * 0.5, y - size, x, y - size * 0.4);
  ctx.bezierCurveTo(x + size * 0.5, y - size, x + size, y - size * 0.8, x + size, y - size * 0.2);
  ctx.bezierCurveTo(x + size, y + size * 0.3, x, y + size * 0.3, x, y + size * 0.8);
  ctx.fill();
}
export type WheelLabelConfig = {
  temperatureReadings: TireTemperatureReading[]; carcassBands: readonly [number | null, number | null, number | null]; fmtTemp: (value: number) => string;
  temperatureThresholds: { cold: number; warm: number; hot: number }; displayBrakeTemp?: string | null;
  wear: number; wearRate: number; brakeTemp: number; pressurePsi: number; pressureOptimal?: { min: number; max: number };
  side: "left" | "right"; isRear: boolean;
};
export type WheelLabelResource = {
  sprite: THREE.Sprite; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture; material: THREE.SpriteMaterial; policy: WheelLabelRefreshPolicy<string>;
  contentKey: string; baseScale: number; cardHeight: number;
};
type LabelCell = { label: string; text: string; color: string };
type LabelRow = { kind: "health"; label: string; values: LabelCell[] } | { kind: "profile"; label: string; values: LabelCell[] } | { kind: "stat"; label: string; values: LabelCell[] };
function labelRows(config: WheelLabelConfig): LabelRow[] {
  const { temperatureReadings, temperatureThresholds } = config;
  const cell = (kind: string, temperature: number | null): LabelCell => ({
    label: kind === "inner" ? m.label_inner() : kind === "middle" ? m.label_middle() : kind === "outer" ? m.label_outer() : kind === "core" ? m.label_core() : kind === "carcass" ? m.label_carcass() : m.label_surface(),
    text: temperature == null ? "—" : config.fmtTemp(temperature),
    color: temperature == null ? "var(--status-unavailable)" : tireTempColor(temperature, temperatureThresholds),
  });
  const surface = temperatureReadings.filter(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  const carcassKinds = config.side === "left" ? ["outer", "middle", "inner"] : ["inner", "middle", "outer"];
  const carcass = config.carcassBands.map((value, index) => cell(carcassKinds[index], value));
  const rows: LabelRow[] = [{ kind: "health", label: `${config.isRear ? "R" : "F"}${config.side === "left" ? "L" : "R"}`, values: [{ label: "", text: `${Math.round((1 - config.wear) * 100)}%`, color: severityRangeColor(config.wear, [0.3, 0.6]) }] }];
  if (surface.length) rows.push({ kind: "profile", label: m.label_surface(), values: surface.map(({ kind, value }) => cell(kind, value)) });
  else { const reading = temperatureReadings.find(({ kind }) => kind === "surface"); if (reading) rows.push({ kind: "profile", label: m.label_surface(), values: [cell("surface", reading.value)] }); }
  if (carcass.some(({ text }) => text !== "—")) rows.push({ kind: "profile", label: m.label_carcass(), values: carcass });
  else { const reading = temperatureReadings.find(({ kind }) => kind === "carcass"); if (reading) rows.push({ kind: "profile", label: m.label_carcass(), values: [cell("carcass", reading.value)] }); }
  for (const reading of temperatureReadings) if (reading.kind === "core") rows.push({ kind: "stat", label: m.label_core(), values: [cell("core", reading.value)] });
  if (config.displayBrakeTemp) rows.push({ kind: "stat", label: "Brake", values: [{ label: "", text: config.displayBrakeTemp, color: brakeTempColor(config.brakeTemp, config.isRear) }] });
  if (config.pressurePsi > 0) rows.push({ kind: "stat", label: "Pressure", values: [{ label: "", text: `${config.pressurePsi.toFixed(1)} psi`, color: tirePressureColor(config.pressurePsi, config.pressureOptimal) }] });
  if (config.wearRate > 0.0001) rows.push({ kind: "stat", label: "Wear", values: [{ label: "", text: `-${(config.wearRate * 100).toFixed(2)}%/s`, color: "var(--telemetry-wear)" }] });
  return rows;
}
export function createWheelLabelResource(scene: THREE.Scene, config: WheelLabelConfig): WheelLabelResource {
  const canvas = document.createElement("canvas"); canvas.width = CARD_W * SCALE; canvas.height = 256 * SCALE;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) throw new Error("Unable to create 3D wheel label canvas");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material); sprite.renderOrder = 999; scene.add(sprite);
  const resource: WheelLabelResource = { sprite, canvas, ctx, texture, material, policy: createWheelLabelRefreshPolicy<string>(), contentKey: "", baseScale: 1.05, cardHeight: 0 };
  updateWheelLabelResource(resource, config, 0, 0, true);
  return resource;
}
/** Coalesces live card changes to 100ms while playing; generation changes force immediate seek/pause/setting paints. */
export function updateWheelLabelResource(resource: WheelLabelResource, config: WheelLabelConfig, now: number, generation: number, playbackActive: boolean): void {
  const rows = labelRows(config), key = JSON.stringify(rows);
  resource.policy.update(key, now, generation);
  const content = resource.policy.consume(now, playbackActive, generation);
  if (content === undefined && resource.contentKey) return;
  if (content !== undefined) resource.contentKey = content;
  const parsed = rows;
  const h = 16 + parsed.reduce((height, row) => height + (row.kind === "profile" && row.values.length > 1 ? ROW_H * 2 : ROW_H), 0);
  if (resource.canvas.height !== h * SCALE) resource.canvas.height = h * SCALE;
  resource.ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); resource.ctx.clearRect(0, 0, CARD_W, h);
  resource.ctx.fillStyle = "color-mix(in srgb, var(--app-bg) 78%, transparent)"; resource.ctx.fillRect(4, 4, CARD_W - 8, h - 8);
  resource.ctx.strokeStyle = "color-mix(in srgb, var(--app-text) 18%, transparent)"; resource.ctx.lineWidth = 2; resource.ctx.strokeRect(4, 4, CARD_W - 8, h - 8);
  resource.ctx.textBaseline = "middle";
  let rowTop = 8;
  parsed.forEach((row) => {
    const rowHeight = row.kind === "profile" && row.values.length > 1 ? ROW_H * 2 : ROW_H;
    const y = rowTop + rowHeight / 2;
    if (row.kind === "profile") {
      if (row.values.length === 1) {
        resource.ctx.font = "var(--font-weight-bold) 20px var(--font-mono)";
        resource.ctx.textAlign = "left"; resource.ctx.fillStyle = "var(--app-text-muted)";
        resource.ctx.fillText(row.label, 14, y);
        resource.ctx.textAlign = "right"; resource.ctx.fillStyle = row.values[0].color;
        resource.ctx.fillText(row.values[0].text, CARD_W - 14, y);
        rowTop += rowHeight;
        return;
      }
      const columnW = (CARD_W - 28) / 3;
      resource.ctx.font = "var(--font-weight-bold) 16px var(--font-mono)";
      resource.ctx.textAlign = "left"; resource.ctx.fillStyle = "var(--app-text-muted)";
      resource.ctx.fillText(row.label, 14, rowTop + 10);
      row.values.forEach((item, index) => {
        const x = 14 + columnW * (index + 0.5);
        resource.ctx.textAlign = "center"; resource.ctx.fillStyle = "var(--app-text-muted)";
        resource.ctx.font = "var(--font-weight-medium) 16px var(--font-mono)";
        resource.ctx.fillText(item.label, x, rowTop + 28, columnW - 4);
        resource.ctx.fillStyle = item.color; resource.ctx.font = "var(--font-weight-bold) 20px var(--font-mono)";
        resource.ctx.fillText(item.text, x, rowTop + 50, columnW - 4);
        resource.ctx.fillRect(x - columnW / 2 + 3, rowTop + 65, columnW - 6, 3);
      });
    } else {
      resource.ctx.font = "var(--font-weight-bold) 20px var(--font-mono)";
      resource.ctx.textAlign = "left"; resource.ctx.fillStyle = row.kind === "health" ? "var(--app-text)" : "var(--app-text-muted)";
      resource.ctx.fillText(row.label, 14, y);
      const item = row.values[0];
      resource.ctx.fillStyle = item.color;
      resource.ctx.font = "var(--font-weight-bold) 18px var(--font-mono)";
      if (row.kind === "health") {
        const heartSize = 12;
        const textWidth = resource.ctx.measureText(item.text).width;
        const left = CARD_W / 2 - (heartSize * 2 + 10 + textWidth) / 2;
        resource.ctx.textAlign = "left";
        drawHeart(resource.ctx, left + heartSize, y, heartSize);
        resource.ctx.fillText(item.text, left + heartSize * 2 + 10, y);
        rowTop += rowHeight;
        return;
      }
      resource.ctx.textAlign = "right"; resource.ctx.fillStyle = item.color;
      resource.ctx.fillText(item.text, CARD_W - 14, y, 145);
    }
    rowTop += rowHeight;
  });
  resource.texture.needsUpdate = true; resource.cardHeight = h;
  const rear = config.isRear, cardX = parsed.some((row) => row.values.length > 1) ? (rear ? -0.45 : 0.45) : 0;
  resource.sprite.position.set(cardX, rear ? 0.65 : 1.25, config.side === "left" ? -0.95 : 0.95);
  resource.sprite.scale.set(resource.baseScale, resource.baseScale * h / CARD_W, 1);
}
export function updateWheelLabelScale(resource: WheelLabelResource, camera: THREE.Camera): void {
  const world = resource.sprite.getWorldPosition(worldPosition);
  const factor = THREE.MathUtils.clamp(camera.position.distanceTo(world) / 4, 1, 2.5);
  resource.sprite.scale.set(resource.baseScale * factor, resource.baseScale * resource.cardHeight / CARD_W * factor, 1);
}
export function disposeWheelLabelResource(resource: WheelLabelResource): void { resource.sprite.removeFromParent(); resource.material.dispose(); resource.texture.dispose(); }
