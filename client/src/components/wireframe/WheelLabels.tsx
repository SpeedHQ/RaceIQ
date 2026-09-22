import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { severityRangeColor } from "../../lib/colors";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { brakeTempColor, tirePressureColor, tireTempColor } from "../../lib/vehicle-dynamics";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { m } from "../../paraglide/messages";

const _tmpVec = new THREE.Vector3();
const REF_DIST = 4;
const MIN_FACTOR = 1;
const MAX_FACTOR = 2.5;

const CARD_W = 240;
const ROW_H = 42;
const PAD_Y = 10;
const CANVAS_SCALE = 2;
const BASE_SCALE = 0.72;

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawHeart(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.8);
  ctx.bezierCurveTo(cx, cy + s * 0.3, cx - s, cy + s * 0.3, cx - s, cy - s * 0.2);
  ctx.bezierCurveTo(cx - s, cy - s * 0.8, cx - s * 0.5, cy - s, cx, cy - s * 0.4);
  ctx.bezierCurveTo(cx + s * 0.5, cy - s, cx + s, cy - s * 0.8, cx + s, cy - s * 0.2);
  ctx.bezierCurveTo(cx + s, cy + s * 0.3, cx, cy + s * 0.3, cx, cy + s * 0.8);
  ctx.closePath();
  ctx.fill();
}


type TemperatureCell = { label: string; value: string; color: string };
type Row =
  | { kind: "health"; pct: string; color: string }
  | ({ kind: "temp" } & TemperatureCell)
  | { kind: "profile"; cells: TemperatureCell[] }
  | { kind: "brake"; value: string; color: string }
  | { kind: "pressure"; text: string; color: string }
  | { kind: "wear"; text: string };

export function WheelInfoCard({
  temperatureReadings,
  fmtTemp,
  temperatureThresholds,
  displayBrakeTemp,
  wear,
  wearRate,
  brakeTemp,
  pressurePsi,
  pressureOptimal,
  side,
  isRear,
}: {
  temperatureReadings: TireTemperatureReading[];
  fmtTemp: (value: number) => string;
  temperatureThresholds: { cold: number; warm: number; hot: number };
  displayBrakeTemp?: string | null;
  wear: number;
  wearRate: number;
  brakeTemp: number;
  pressurePsi: number;
  pressureOptimal?: { min: number; max: number };
  side: "left" | "right";
  isRear: boolean;
}) {
  const healthPct = ((1 - wear) * 100).toFixed(0);
  const healthColor = severityRangeColor(wear, [0.3, 0.6]);
  const brakeText = displayBrakeTemp ?? null;
  const brakeColor = brakeTempColor(brakeTemp, isRear);
  const pressureText = pressurePsi > 0 ? `${pressurePsi.toFixed(1)} psi` : null;
  const pressureColor = tirePressureColor(pressurePsi, pressureOptimal);
  const wearText = wearRate > 0.0001 ? `-${(wearRate * 100).toFixed(2)}%/s` : null;
  const hasProfile = temperatureReadings.some(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  const cardW = hasProfile ? 360 : CARD_W;
  const baseScale = BASE_SCALE * cardW / CARD_W;
  const { rows, cardH } = useMemo(() => {
    const rows: Row[] = [{ kind: "health", pct: healthPct, color: healthColor }];
    const cell = ({ kind, value }: TireTemperatureReading): TemperatureCell => ({
      label: kind === "inner" ? m.label_inner() : kind === "middle" ? m.label_middle() : kind === "outer" ? m.label_outer() : kind === "core" ? m.label_core() : kind === "carcass" ? m.analyse_wheels_pit_temp() : m.label_surface(),
      value: value == null ? "—" : fmtTemp(value),
      color: value == null ? "var(--status-unavailable)" : tireTempColor(value, temperatureThresholds),
    });
    if (hasProfile) {
      rows.push({ kind: "profile", cells: temperatureReadings.filter(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer").map(cell) });
    }
    for (const reading of temperatureReadings) {
      if (!hasProfile || reading.kind === "core") rows.push({ kind: "temp", ...cell(reading) });
    }
    if (brakeText) rows.push({ kind: "brake", value: brakeText, color: brakeColor });
    if (pressureText) rows.push({ kind: "pressure", text: pressureText, color: pressureColor });
    if (wearText) rows.push({ kind: "wear", text: wearText });
    return { rows, cardH: PAD_Y * 2 + rows.reduce((height, row) => height + (row.kind === "profile" ? ROW_H * 2 : ROW_H), 0) };
  }, [brakeColor, brakeText, fmtTemp, hasProfile, healthColor, healthPct, pressureColor, pressureText, temperatureReadings, temperatureThresholds, wearText]);

  const { canvas, ctx, texture, material } = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W * CANVAS_SCALE;
    canvas.height = (PAD_Y * 2 + 2 * ROW_H) * CANVAS_SCALE;
    const ctx = getSemanticCanvasContext(canvas);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    return { canvas, ctx, texture, material };
  }, []);

  useLayoutEffect(() => {
    if (!ctx) return;
    if (canvas.width !== cardW * CANVAS_SCALE) canvas.width = cardW * CANVAS_SCALE;
    if (canvas.height !== cardH * CANVAS_SCALE) canvas.height = cardH * CANVAS_SCALE;
    ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
    ctx.clearRect(0, 0, cardW, cardH);

    // Background card — subtle, high-contrast, rounded
    drawRoundedRect(ctx, 4, 4, cardW - 8, cardH - 8, 16);
    ctx.fillStyle = "color-mix(in srgb, var(--app-bg) 78%, transparent)";
    ctx.fill();
    ctx.strokeStyle = "color-mix(in srgb, var(--app-text) 18%, transparent)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    let rowTop = PAD_Y;
    rows.forEach((row) => {
      const y = rowTop + ROW_H / 2;
      rowTop += row.kind === "profile" ? ROW_H * 2 : ROW_H;
      if (row.kind === "health") {
        ctx.textAlign = "left";
        ctx.fillStyle = "var(--app-text-muted)";
        ctx.font = "var(--font-weight-medium) var(--text-xl) var(--font-mono)";
        ctx.fillText(`${isRear ? "R" : "F"}${side === "left" ? "L" : "R"}`, 12, y);
        ctx.font = "var(--font-weight-bold) var(--text-2xl) var(--font-mono)";
        const text = `${row.pct}%`;
        const metrics = ctx.measureText(text);
        const heartSize = 13;
        const groupW = heartSize * 2 + 10 + metrics.width;
        const left = cardW / 2 - groupW / 2;
        drawHeart(ctx, left + heartSize, y, heartSize, row.color);
        ctx.fillStyle = row.color;
        ctx.textAlign = "left";
        ctx.fillText(text, left + heartSize * 2 + 10, y);
        ctx.textAlign = "center";
      } else if (row.kind === "profile") {
        const columnW = (cardW - 24) / 3;
        row.cells.forEach((cell, index) => {
          const x = 12 + columnW * (index + 0.5);
          ctx.textAlign = "center";
          ctx.fillStyle = "var(--app-text-muted)";
          ctx.font = "var(--font-weight-medium) var(--text-xl) var(--font-mono)";
          ctx.fillText(cell.label, x, y, columnW - 8);
          ctx.fillStyle = cell.color;
          ctx.font = "var(--font-weight-bold) var(--text-app-visualization-emphasis) var(--font-mono)";
          ctx.fillText(cell.value, x, y + ROW_H, columnW - 8);
          ctx.fillRect(x - columnW / 2 + 4, y + ROW_H * 1.5 - 4, columnW - 8, 3);
        });
      } else if (row.kind === "temp") {
        ctx.font = "var(--font-weight-bold) var(--text-app-visualization-emphasis) var(--font-mono)";
        ctx.fillStyle = row.color;
        ctx.textAlign = "left";
        ctx.fillText(row.label, 12, y, (cardW - 32) / 2);
        ctx.textAlign = "right";
        ctx.fillText(row.value, cardW - 12, y, (cardW - 32) / 2);
      } else if (row.kind === "brake") {
        ctx.font = "var(--font-weight-bold) var(--text-2xl) var(--font-mono)";
        ctx.fillStyle = row.color;
        ctx.textAlign = "left";
        ctx.fillText("Brake", 12, y);
        ctx.textAlign = "right";
        ctx.fillText(row.value, cardW - 12, y);
      } else if (row.kind === "pressure") {
        ctx.font = "var(--font-weight-bold) var(--text-app-visualization-value) var(--font-mono)";
        ctx.fillStyle = row.color;
        ctx.textAlign = "center";
        ctx.fillText(row.text, cardW / 2, y);
      } else if (row.kind === "wear") {
        ctx.font = "var(--font-weight-bold) var(--text-xl) var(--font-mono)";
        ctx.fillStyle = "var(--telemetry-wear)";
        ctx.textAlign = "center";
        ctx.fillText(row.text, cardW / 2, y);
      }
    });

    texture.needsUpdate = true;
  }, [canvas, cardH, cardW, ctx, isRear, rows, side, texture]);

  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
    },
    [material, texture],
  );

  const scaleY = baseScale * (cardH / cardW);
  const spriteRef = useRef<THREE.Sprite>(null);

  // Distance-normalise scale so far cards stay readable.
  // Clamped so close-up cards don't shrink below baseline.
  useFrame(({ camera }) => {
    if (!spriteRef.current) return;
    spriteRef.current.getWorldPosition(_tmpVec);
    const dist = camera.position.distanceTo(_tmpVec);
    const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, dist / REF_DIST));
    spriteRef.current.scale.set(baseScale * factor, scaleY * factor, 1);
  });

  // Rear cards sit ~0.6m lower so they don't stack on top of the front cards
  // in screen space when the camera is directly behind (or in front of) the car.
  const cardY = isRear ? 0.65 : 1.25;
  const cardX = hasProfile ? (isRear ? -0.45 : 0.45) : 0;
  const cardZ = hasProfile ? 1.15 : 0.95;
  return <sprite ref={spriteRef} material={material} position={[cardX, cardY, side === "left" ? -cardZ : cardZ]} scale={[baseScale, scaleY, 1]} renderOrder={999} dispose={null} />;
}
