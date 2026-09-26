import * as THREE from "three/webgpu";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { createWheelLabelRefreshPolicy, type WheelLabelRefreshPolicy } from "../../lib/wheel-label-refresh";
import { brakeTempColor, tirePressureColor, tireTempColor } from "../../lib/vehicle-dynamics";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { severityRangeColor } from "../../lib/colors";
import { m } from "../../paraglide/messages";

const CARD_W = 240, ROW_H = 34, SCALE = 2;
export type WheelLabelConfig = {
  temperatureReadings: TireTemperatureReading[]; fmtTemp: (value: number) => string;
  temperatureThresholds: { cold: number; warm: number; hot: number }; displayBrakeTemp?: string | null;
  wear: number; wearRate: number; brakeTemp: number; pressurePsi: number; pressureOptimal?: { min: number; max: number };
  side: "left" | "right"; isRear: boolean;
};
export type WheelLabelResource = {
  sprite: THREE.Sprite; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture; material: THREE.SpriteMaterial; policy: WheelLabelRefreshPolicy<string>;
  contentKey: string; baseScale: number; cardHeight: number;
};
type LabelRow = { label: string; values: { text: string; color: string }[] };
function labelRows(config: WheelLabelConfig): LabelRow[] {
  const { temperatureReadings, temperatureThresholds } = config;
  const value = (reading: TireTemperatureReading) => ({
    text: reading.value == null ? "—" : config.fmtTemp(reading.value),
    color: reading.value == null ? "var(--status-unavailable)" : tireTempColor(reading.value, temperatureThresholds),
  });
  const rows: LabelRow[] = [{
    label: `${config.isRear ? "R" : "F"}${config.side === "left" ? "L" : "R"}`,
    values: [{ text: `${Math.round((1 - config.wear) * 100)}%`, color: severityRangeColor(config.wear, [0.3, 0.6]) }],
  }];
  const bands = temperatureReadings.filter(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  if (bands.length) rows.push({ label: m.label_surface(), values: bands.map(value) });
  const label = (kind: string): string => kind === "core" ? m.label_core() : kind === "carcass" ? m.label_carcass() : m.label_surface();
  for (const reading of temperatureReadings) {
    if (bands.length && (reading.kind === "inner" || reading.kind === "middle" || reading.kind === "outer" || reading.kind === "surface")) continue;
    rows.push({ label: label(reading.kind), values: [value(reading)] });
  }
  if (config.displayBrakeTemp) rows.push({ label: "Brake", values: [{ text: config.displayBrakeTemp, color: brakeTempColor(config.brakeTemp, config.isRear) }] });
  if (config.pressurePsi > 0) rows.push({ label: "Pressure", values: [{ text: `${config.pressurePsi.toFixed(1)} psi`, color: tirePressureColor(config.pressurePsi, config.pressureOptimal) }] });
  if (config.wearRate > 0.0001) rows.push({ label: "Wear", values: [{ text: `-${(config.wearRate * 100).toFixed(2)}%/s`, color: "var(--telemetry-wear)" }] });
  return rows;
}
export function createWheelLabelResource(scene: THREE.Scene, config: WheelLabelConfig): WheelLabelResource {
  const canvas = document.createElement("canvas"); canvas.width = CARD_W * SCALE; canvas.height = 256 * SCALE;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) throw new Error("Unable to create 3D wheel label canvas");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material); sprite.renderOrder = 999; scene.add(sprite);
  const resource: WheelLabelResource = { sprite, canvas, ctx, texture, material, policy: createWheelLabelRefreshPolicy<string>(), contentKey: "", baseScale: 0.72, cardHeight: 0 };
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
  const h = 16 + parsed.length * ROW_H;
  if (resource.canvas.height !== h * SCALE) resource.canvas.height = h * SCALE;
  resource.ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0); resource.ctx.clearRect(0, 0, CARD_W, h);
  resource.ctx.fillStyle = "color-mix(in srgb, var(--app-bg) 78%, transparent)"; resource.ctx.fillRect(4, 4, CARD_W - 8, h - 8);
  resource.ctx.strokeStyle = "color-mix(in srgb, var(--app-text) 18%, transparent)"; resource.ctx.lineWidth = 2; resource.ctx.strokeRect(4, 4, CARD_W - 8, h - 8);
  resource.ctx.textBaseline = "middle";
  parsed.forEach((row, i) => {
    const y = 8 + ROW_H * (i + 0.5);
    resource.ctx.font = "var(--font-weight-bold) 20px var(--font-mono)";
    resource.ctx.textAlign = "left"; resource.ctx.fillStyle = i === 0 ? "var(--app-text)" : "var(--app-text-muted)";
    resource.ctx.fillText(row.label, 14, y);
    resource.ctx.font = "var(--font-weight-bold) 18px var(--font-mono)";
    row.values.forEach((item, index) => {
      resource.ctx.textAlign = row.values.length === 1 ? "right" : "center";
      resource.ctx.fillStyle = item.color;
      resource.ctx.fillText(item.text, row.values.length === 1 ? CARD_W - 14 : 111 + index * 56, y, row.values.length === 1 ? 145 : 54);
    });
  });
  resource.texture.needsUpdate = true; resource.cardHeight = h;
  const rear = config.isRear, cardX = parsed.some((row) => row.values.length > 1) ? (rear ? -0.45 : 0.45) : 0;
  resource.sprite.position.set(cardX, rear ? 0.65 : 1.25, config.side === "left" ? -0.95 : 0.95);
  resource.sprite.scale.set(resource.baseScale, resource.baseScale * h / CARD_W, 1);
}
export function updateWheelLabelScale(resource: WheelLabelResource, camera: THREE.Camera): void {
  const world = resource.sprite.getWorldPosition(new THREE.Vector3());
  const factor = THREE.MathUtils.clamp(camera.position.distanceTo(world) / 4, 1, 2.5);
  resource.sprite.scale.set(resource.baseScale * factor, resource.baseScale * resource.cardHeight / CARD_W * factor, 1);
}
export function disposeWheelLabelResource(resource: WheelLabelResource): void { resource.sprite.removeFromParent(); resource.material.dispose(); resource.texture.dispose(); }
