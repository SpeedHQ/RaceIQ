import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { brakeTempColor, tirePressureColor, COLORS_HEX } from "../../lib/vehicle-dynamics";

const _tmpVec = new THREE.Vector3();
const REF_DIST = 4;
const MIN_FACTOR = 1;
const MAX_FACTOR = 2.5;

const CARD_W = 200;
const ROW_H = 42;
const PAD_Y = 10;
const BASE_SCALE = 0.62;

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

function drawBrakeIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string) {
  const r = 14;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.stroke();
  for (let a = 0; a < 6; a++) {
    const angle = (a / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * 6, cy + Math.sin(angle) * 6);
    ctx.lineTo(cx + Math.cos(angle) * 12, cy + Math.sin(angle) * 12);
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, -0.6, 0.6);
  ctx.stroke();
}

type Row =
  | { kind: "health"; pct: string; color: string }
  | { kind: "temp"; text: string; color: string }
  | { kind: "brake"; text: string; color: string }
  | { kind: "pressure"; text: string; color: string }
  | { kind: "wear"; text: string };

export function WheelInfoCard({
  displayTemp,
  tempColor,
  wear,
  wearRate,
  brakeTemp,
  pressurePsi,
  pressureOptimal,
  side,
  isRear,
}: {
  displayTemp: string;
  tempColor: string;
  wear: number;
  wearRate: number;
  brakeTemp: number;
  pressurePsi: number;
  pressureOptimal?: { min: number; max: number };
  side: "left" | "right";
  isRear: boolean;
}) {
  const { texture, cardH } = useMemo(() => {
    const health = 1 - wear;
    const pct = (health * 100).toFixed(0);
    const healthColor = health > 0.7 ? "#34d399" : health > 0.4 ? "#fbbf24" : "#ef4444";
    const brakeCol = COLORS_HEX[brakeTempColor(brakeTemp, isRear)];
    const pressureCol = COLORS_HEX[tirePressureColor(pressurePsi, pressureOptimal)];

    const rows: Row[] = [
      { kind: "health", pct, color: healthColor },
      { kind: "temp", text: displayTemp, color: tempColor },
    ];
    if (pressurePsi > 0) rows.push({ kind: "pressure", text: `${pressurePsi.toFixed(1)} psi`, color: pressureCol });
    if (brakeTemp > 0) rows.push({ kind: "brake", text: `${brakeTemp.toFixed(0)}°C`, color: brakeCol });
    if (wearRate > 0.0001) rows.push({ kind: "wear", text: `-${(wearRate * 100).toFixed(2)}%/s` });

    const h = PAD_Y * 2 + rows.length * ROW_H;
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, CARD_W, h);

    // Background card — subtle, high-contrast, rounded
    drawRoundedRect(ctx, 4, 4, CARD_W - 8, h - 8, 16);
    ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    rows.forEach((row, i) => {
      const y = PAD_Y + i * ROW_H + ROW_H / 2;
      if (row.kind === "health") {
        ctx.font = "bold 24px monospace";
        const text = `${row.pct}%`;
        const metrics = ctx.measureText(text);
        const heartSize = 13;
        const groupW = heartSize * 2 + 10 + metrics.width;
        const left = CARD_W / 2 - groupW / 2;
        drawHeart(ctx, left + heartSize, y, heartSize, row.color);
        ctx.fillStyle = row.color;
        ctx.textAlign = "left";
        ctx.fillText(text, left + heartSize * 2 + 10, y);
        ctx.textAlign = "center";
      } else if (row.kind === "temp") {
        ctx.font = "bold 28px monospace";
        ctx.fillStyle = row.color;
        ctx.fillText(row.text, CARD_W / 2, y);
      } else if (row.kind === "brake") {
        ctx.font = "bold 24px monospace";
        const metrics = ctx.measureText(row.text);
        const iconW = 36;
        const groupW = iconW + 8 + metrics.width;
        const left = CARD_W / 2 - groupW / 2;
        drawBrakeIcon(ctx, left + iconW / 2, y, row.color);
        ctx.fillStyle = row.color;
        ctx.textAlign = "left";
        ctx.fillText(row.text, left + iconW + 8, y);
        ctx.textAlign = "center";
      } else if (row.kind === "pressure") {
        ctx.font = "bold 22px monospace";
        ctx.fillStyle = row.color;
        ctx.fillText(row.text, CARD_W / 2, y);
      } else if (row.kind === "wear") {
        ctx.font = "bold 20px monospace";
        ctx.fillStyle = "#f97316";
        ctx.fillText(row.text, CARD_W / 2, y);
      }
    });

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return { texture: tex, cardH: h };
  }, [displayTemp, tempColor, wear, wearRate, brakeTemp, isRear, pressurePsi, pressureOptimal]);

  const scaleY = BASE_SCALE * (cardH / CARD_W);
  const spriteRef = useRef<THREE.Sprite>(null);

  // Distance-normalise scale so far cards stay readable.
  // Clamped so close-up cards don't shrink below baseline.
  useFrame(({ camera }) => {
    if (!spriteRef.current) return;
    spriteRef.current.getWorldPosition(_tmpVec);
    const dist = camera.position.distanceTo(_tmpVec);
    const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, dist / REF_DIST));
    spriteRef.current.scale.set(BASE_SCALE * factor, scaleY * factor, 1);
  });

  // Rear cards sit ~0.6m lower so they don't stack on top of the front cards
  // in screen space when the camera is directly behind (or in front of) the car.
  const cardY = isRear ? 0.65 : 1.25;
  return (
    <sprite
      ref={spriteRef}
      position={[0, cardY, side === "left" ? -0.95 : 0.95]}
      scale={[BASE_SCALE, scaleY, 1]}
      renderOrder={999}
    >
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}
