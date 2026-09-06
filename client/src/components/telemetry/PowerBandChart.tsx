import { useEffect, useLayoutEffect, useRef } from "react";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import type { GearingSample } from "../../lib/gearing-telemetry";
import { findVisualCrossing, interpolateValue } from "../../lib/gearing-ratios";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";

interface Props {
  packet: GearingSample | null;
  powerCurve: { rpm: number; powerW: number }[];
  torqueCurve: { rpm: number; nm: number }[];
  /** Best shift RPM from the power-drop heuristic; null = none/redline. */
  shiftPointRpm?: number | null;
  /** Whether live dyno samples are being recorded (controls only). */
  recording?: boolean;
  /** Master switch for the automatic start/stop triggers. */
  autoRecording?: boolean;
  /** When both handlers are provided, the header renders recording controls. */
  onToggleRecording?: () => void;
  onToggleAutoRecording?: () => void;
  onReset?: () => void;
}

/**
 * Main canvas chart: overall Power (HP) & Torque (Nm) vs RPM.
 * Shows a single power line, a single torque line, peak markers,
 * power band highlight, and a live RPM needle.
 * Hovering the chart renders a crosshair + tooltip with RPM / HP / Nm.
 */
export function PowerBandChart({ packet, powerCurve, torqueCurve, shiftPointRpm = null, recording = false, autoRecording = true, onToggleRecording, onToggleAutoRecording, onReset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef(() => {});
  // Hover state kept in refs to avoid re-renders; draw loop reads them on every frame.
  const hoverXRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirror props into refs so the draw closure (registered once) always sees
  // fresh values without re-running on every 50 ms poll re-render.
  const packetRef = useRef(packet);
  const powerCurveRef = useRef(powerCurve);
  const torqueCurveRef = useRef(torqueCurve);
  const shiftPointRef = useRef(shiftPointRpm);
  packetRef.current = packet;
  powerCurveRef.current = powerCurve;
  torqueCurveRef.current = torqueCurve;
  shiftPointRef.current = shiftPointRpm;

  useLayoutEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const ctx = getSemanticCanvasContext(canvas);
      if (!ctx) return;

      const width = container.clientWidth;
      const height = 280;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const packet = packetRef.current;
      const powerCurve = powerCurveRef.current;
      const torqueCurve = torqueCurveRef.current;
      // Canonical watts → HP, only for the axis/peak/tooltip readouts.
      const hpCurve = powerCurve.map((p) => ({ rpm: p.rpm, hp: p.powerW / WATTS_PER_HORSEPOWER }));

      const idleRpm = packet?.EngineIdleRpm ?? 0;
      const maxRpm = packet && packet.EngineMaxRpm > 0 ? packet.EngineMaxRpm : 8000;
      const pad = { top: 20, right: 48, bottom: 32, left: 48 };
      const cW = width - pad.left - pad.right;
      const cH = height - pad.top - pad.bottom;

      const sx = (rpm: number) => pad.left + ((rpm - idleRpm) / (maxRpm - idleRpm)) * cW;
      const syHp = (hp: number, maxHp: number) => pad.top + cH - (hp / maxHp) * cH;
      const syNm = (nm: number, maxNm: number) => pad.top + cH - (nm / maxNm) * cH;

      const hasPower = hpCurve.length > 0;
      const hasTorque = torqueCurve.length > 0;

      const globalMaxHp = Math.max(1, ...(hasPower ? hpCurve.map((p) => p.hp) : [1])) * 1.05;
      const globalMaxNm = Math.max(1, ...(hasTorque ? torqueCurve.map((t) => t.nm) : [1])) * 1.05;

      // Find peak power and peak torque points
      let peakPower: { rpm: number; hp: number } | null = null;
      let peakTorque: { rpm: number; nm: number } | null = null;

      for (const p of hpCurve) {
        if (!peakPower || p.hp > peakPower.hp) peakPower = p;
      }
      for (const t of torqueCurve) {
        if (!peakTorque || t.nm > peakTorque.nm) peakTorque = t;
      }

      // Background
      ctx.fillStyle = "color-mix(in srgb, var(--app-text) 3%, transparent)";
      ctx.fillRect(pad.left, pad.top, cW, cH);

      // Highlight power band (peak torque RPM -> peak power RPM)
      if (peakTorque && peakPower && peakTorque.rpm < peakPower.rpm) {
        const x1 = sx(peakTorque.rpm);
        const x2 = sx(peakPower.rpm);
        ctx.fillStyle = "color-mix(in srgb, var(--telemetry-power-band) 12%, transparent)";
        ctx.fillRect(x1, pad.top, x2 - x1, cH);
      }

      // Gridlines — tick every 1000 RPM, labeled with full RPM value
      ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 10%, transparent)";
      ctx.lineWidth = 1;
      ctx.font = "var(--text-app-label) var(--font-mono)";
      ctx.fillStyle = "var(--app-text-dim)";
      ctx.textAlign = "center";
      const rpmStep = 1000;
      const firstTick = Math.ceil(idleRpm / rpmStep) * rpmStep;
      for (let rpm = firstTick; rpm <= maxRpm; rpm += rpmStep) {
        const x = sx(rpm);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + cH);
        ctx.stroke();
        ctx.fillText(String(rpm), x, pad.top + cH + 16);
      }

      // Y-axis grids (HP left)
      ctx.fillStyle = "var(--telemetry-power)";
      ctx.textAlign = "right";
      for (let i = 0; i <= 2; i++) {
        const hp = (globalMaxHp * i) / 2;
        const y = syHp(hp, globalMaxHp);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + cW, y);
        ctx.stroke();
        ctx.fillText(`${hp.toFixed(0)}`, pad.left - 6, y + 4);
      }

      // Y-axis grids (Nm right)
      ctx.fillStyle = "var(--telemetry-torque)";
      ctx.textAlign = "left";
      for (let i = 0; i <= 2; i++) {
        const nm = (globalMaxNm * i) / 2;
        const y = syNm(nm, globalMaxNm);
        ctx.fillText(`${nm.toFixed(0)}`, pad.left + cW + 6, y + 4);
      }

      // Axis labels
      ctx.fillStyle = "var(--app-text-muted)";
      ctx.font = "var(--text-app-label) var(--font-mono)";
      ctx.textAlign = "center";
      ctx.fillText("RPM", pad.left + cW / 2, height - 6);
      ctx.save();
      ctx.translate(10, pad.top + cH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("HP", 0, 0);
      ctx.restore();
      ctx.save();
      ctx.translate(width - 10, pad.top + cH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText("Nm", 0, 0);
      ctx.restore();

      // Draw single power line (solid cyan)
      if (hasPower) {
        ctx.beginPath();
        for (let i = 0; i < hpCurve.length; i++) {
          const p = hpCurve[i];
          if (i === 0) ctx.moveTo(sx(p.rpm), syHp(p.hp, globalMaxHp));
          else ctx.lineTo(sx(p.rpm), syHp(p.hp, globalMaxHp));
        }
        ctx.strokeStyle = "var(--telemetry-power)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Draw single torque line (dashed purple)
      if (hasTorque) {
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        for (let i = 0; i < torqueCurve.length; i++) {
          const t = torqueCurve[i];
          if (i === 0) ctx.moveTo(sx(t.rpm), syNm(t.nm, globalMaxNm));
          else ctx.lineTo(sx(t.rpm), syNm(t.nm, globalMaxNm));
        }
        ctx.strokeStyle = "var(--telemetry-torque)";
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Visual intersection of power and torque lines
      let crossLabel: { rpm: number; x: number } | null = null;
      if (hasPower && hasTorque) {
        const crossRpm = findVisualCrossing(powerCurve, torqueCurve, globalMaxHp * WATTS_PER_HORSEPOWER, globalMaxNm);
        if (crossRpm != null) {
          const cx = sx(crossRpm);
          crossLabel = { rpm: crossRpm, x: cx };
          ctx.strokeStyle = "color-mix(in srgb, var(--app-text) 40%, transparent)";
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx, pad.top);
          ctx.lineTo(cx, pad.top + cH);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Redline (red dashed)
      const redX = sx(maxRpm);
      ctx.strokeStyle = "var(--status-danger)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(redX, pad.top);
      ctx.lineTo(redX, pad.top + cH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "var(--status-danger)";
      ctx.font = "var(--text-app-label) var(--font-mono)";
      ctx.textAlign = "center";
      ctx.fillText(`${m.powerband_legend_redline()} ${Math.round(maxRpm)}`, redX, pad.top - 6);

      // Live RPM needle (white triangle) — only with a resolved sample.
      if (packet) {
        const cx = sx(packet.rpm);
        ctx.fillStyle = "var(--app-text)";
        ctx.beginPath();
        ctx.moveTo(cx, pad.top + cH + 4);
        ctx.lineTo(cx - 5, pad.top + cH + 12);
        ctx.lineTo(cx + 5, pad.top + cH + 12);
        ctx.fill();
      }

      // Decide label placement to avoid overlaps
      const px = peakPower ? sx(peakPower.rpm) : null;
      const py = peakPower ? syHp(peakPower.hp, globalMaxHp) : null;
      const tx = peakTorque ? sx(peakTorque.rpm) : null;
      const ty = peakTorque ? syNm(peakTorque.nm, globalMaxNm) : null;

      let powerAbove = true;
      let torqueAbove = true;
      let powerAlign: CanvasTextAlign = "center";
      let torqueAlign: CanvasTextAlign = "center";
      if (px != null && tx != null) {
        // Measure label widths so we can split horizontally when they'd overlap
        ctx.font = "var(--text-app-caption) var(--font-sans)";
        const powerText = `${m.powerband_legend_peak_power()} ${Math.round(peakPower?.hp ?? 0)} @ ${Math.round(peakPower?.rpm ?? 0)}`;
        const torqueText = `${m.powerband_legend_peak_torque()} ${Math.round(peakTorque?.nm ?? 0)} @ ${Math.round(peakTorque?.rpm ?? 0)}`;
        const minGap = (ctx.measureText(powerText).width + ctx.measureText(torqueText).width + 20) / 2 + 4;
        const horizGap = Math.abs(px - tx);
        const vertGap = py != null && ty != null ? Math.abs(py - ty) : 0;

        if (horizGap < minGap && vertGap < 20) {
          // Labels would overlap: split horizontally away from each other.
          // Torque (left peak) extends left; Power (right peak) extends right.
          if (px >= tx) {
            torqueAlign = "right";
            powerAlign = "left";
          } else {
            powerAlign = "right";
            torqueAlign = "left";
          }
          torqueAbove = false;
        } else if (horizGap < 50) {
          // Close but vertically separated: just alternate vertically
          powerAbove = true;
          torqueAbove = false;
        }
      }
      // If peak power is near the right edge (redline), bias its label left
      // so it doesn't overlap the redline annotation. Do this after the
      // torque-overlap block so it only fires when power is still centered.
      if (px != null && redX - px < 70 && powerAlign === "center") {
        powerAlign = "left";
      }

      // Peak power marker + label
      if (peakPower && px != null && py != null) {
        ctx.fillStyle = "var(--telemetry-power)";
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        drawLabel(ctx, `${m.powerband_legend_peak_power()} ${Math.round(peakPower.hp)} @ ${Math.round(peakPower.rpm)}`, px, py, "var(--telemetry-power)", powerAbove, powerAlign);
      }

      // Peak torque marker + label
      if (peakTorque && tx != null && ty != null) {
        ctx.fillStyle = "var(--telemetry-torque)";
        ctx.beginPath();
        ctx.arc(tx, ty, 4, 0, Math.PI * 2);
        ctx.fill();
        drawLabel(ctx, `${m.powerband_legend_peak_torque()} ${Math.round(peakTorque.nm)} @ ${Math.round(peakTorque.rpm)}`, tx, ty, "var(--telemetry-torque)", torqueAbove, torqueAlign);
      }
      // Best shift point (power-drop heuristic) — vertical dashed line + label
      const shiftRpm = shiftPointRef.current;
      if (shiftRpm != null && shiftRpm > idleRpm && shiftRpm < maxRpm) {
        const sxShift = sx(shiftRpm);
        ctx.strokeStyle = "var(--app-accent)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sxShift, pad.top);
        ctx.lineTo(sxShift, pad.top + cH);
        ctx.stroke();
        ctx.setLineDash([]);
        drawLabel(ctx, `${m.powerband_shift()} @ ${Math.round(shiftRpm)}`, sxShift, pad.top + cH - 6, "var(--app-accent)", false, "center");
      }

      if (crossLabel) {
        drawLabel(ctx, `${m.powerband_legend_cross()} @ ${Math.round(crossLabel.rpm)}`, crossLabel.x, pad.top + cH - 6, "var(--app-text)", false, "center");
      }

      // // Power band label — only when the band is wide enough to not collide
      // // with the (possibly split) peak labels at each edge.
      // if (peakTorque && peakPower && peakTorque.rpm < peakPower.rpm) {
      //   const midX = (sx(peakTorque.rpm) + sx(peakPower.rpm)) / 2;
      //   const bandWidthPx = Math.abs(sx(peakPower.rpm) - sx(peakTorque.rpm));
      //   const bandText = m.powerband_legend_power_band().toUpperCase();
      //   ctx.font = "var(--text-app-caption) var(--font-sans)";
      //   const bandLabelW = ctx.measureText(bandText).width + 10;
      //   const labelsWereSplit = powerAlign !== "center" || torqueAlign !== "center";
      //   const tooNarrow = bandWidthPx < bandLabelW + (labelsWereSplit ? 80 : 24);
      //   if (!tooNarrow) {
      //     // Prefer top of band, but nudge down if it would collide with peak labels
      //     let bandY = pad.top + 14;
      //     if (px != null && Math.abs(midX - px) < 40 && powerAbove) bandY = pad.top + 28;
      //     if (tx != null && Math.abs(midX - tx) < 40 && torqueAbove) bandY = pad.top + 28;
      //     drawLabel(ctx, bandText, midX, bandY, "var(--status-warning)", false, "center", "color-mix(in srgb, var(--app-bg) 45%, transparent)");
      //   }
      // }

      // Fallback message when no data yet
      if (!hasPower && !hasTorque) {
        ctx.fillStyle = "var(--app-text-dim)";
        ctx.font = "var(--text-app-subtext) var(--font-sans)";
        ctx.textAlign = "center";
        ctx.fillText(m.powerband_empty_state(), pad.left + cW / 2, pad.top + cH / 2);
      }

      // Hover crosshair + tooltip
      const hoverX = hoverXRef.current;
      if (hoverX !== null) {
        const hoverRpm = idleRpm + ((hoverX - pad.left) / cW) * (maxRpm - idleRpm);
        if (hoverRpm >= idleRpm && hoverRpm <= maxRpm) {
          const cxHover = sx(hoverRpm);

          // Vertical crosshair line
          ctx.save();
          ctx.strokeStyle = "var(--app-text-dim)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(cxHover, pad.top);
          ctx.lineTo(cxHover, pad.top + cH);
          ctx.stroke();
          ctx.setLineDash([]);

          const hoverHp = hasPower ? interpolateValue(hpCurve, hoverRpm, "hp") : 0;
          const hoverNm = hasTorque ? interpolateValue(torqueCurve, hoverRpm, "nm") : 0;

          // Dot on power curve
          if (hasPower && hoverHp > 0) {
            ctx.fillStyle = "var(--telemetry-power)";
            ctx.beginPath();
            ctx.arc(cxHover, syHp(hoverHp, globalMaxHp), 4, 0, Math.PI * 2);
            ctx.fill();
          }

          // Dot on torque curve
          if (hasTorque && hoverNm > 0) {
            ctx.fillStyle = "var(--telemetry-torque)";
            ctx.beginPath();
            ctx.arc(cxHover, syNm(hoverNm, globalMaxNm), 4, 0, Math.PI * 2);
            ctx.fill();
          }

          // Tooltip box
          const tooltipLines: { label: string; value: string; color: string }[] = [{ label: "RPM", value: Math.round(hoverRpm).toLocaleString(), color: "var(--app-text)" }];
          if (hasPower) tooltipLines.push({ label: "HP", value: Math.round(hoverHp).toString(), color: "var(--telemetry-power)" });
          if (hasTorque) tooltipLines.push({ label: "Nm", value: Math.round(hoverNm).toString(), color: "var(--telemetry-torque)" });

          const tFont = "var(--text-app-label) var(--font-mono)";
          ctx.font = tFont;
          const lineH = 16;
          const tPadX = 8;
          const tPadY = 6;
          const labelW = 24; // fixed width reserved for the label text
          const maxValueW = Math.max(...tooltipLines.map((l) => ctx.measureText(l.value).width));
          const tooltipW = tPadX + labelW + 6 + maxValueW + tPadX;
          const tooltipH = tooltipLines.length * lineH + tPadY * 2;

          // Flip tooltip to the left when cursor is in the right 40 % of the chart
          const toRight = cxHover < pad.left + cW * 0.6;
          const tooltipXPos = toRight ? cxHover + 10 : cxHover - tooltipW - 10;
          const tooltipYPos = pad.top + 6;

          // Background + border
          ctx.fillStyle = "color-mix(in srgb, var(--app-surface) 92%, transparent)";
          ctx.beginPath();
          ctx.roundRect(tooltipXPos, tooltipYPos, tooltipW, tooltipH, 5);
          ctx.fill();
          ctx.strokeStyle = "var(--app-border)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(tooltipXPos, tooltipYPos, tooltipW, tooltipH, 5);
          ctx.stroke();

          // Rows
          for (let i = 0; i < tooltipLines.length; i++) {
            const { label, value, color } = tooltipLines[i];
            const lineY = tooltipYPos + tPadY + i * lineH + lineH / 2;

            ctx.font = "var(--text-app-caption) var(--font-sans)";
            ctx.fillStyle = "var(--app-text-muted)";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, tooltipXPos + tPadX, lineY);

            ctx.font = tFont;
            ctx.fillStyle = color;
            ctx.textAlign = "right";
            ctx.fillText(value, tooltipXPos + tooltipW - tPadX, lineY);
          }
          ctx.textBaseline = "alphabetic";
          ctx.restore();
        }
      }

      // Border
      ctx.strokeStyle = "var(--app-border)";
      ctx.lineWidth = 1;
      ctx.strokeRect(pad.left, pad.top, cW, cH);
    };
  }, []); // stable — reads from refs, no re-registration needed

  useEffect(() => {
    drawRef.current();
    const id = setInterval(() => drawRef.current(), 200);
    return () => clearInterval(id);
  }, []);

  // Mouse hover: update ref and schedule an immediate redraw so the tooltip
  // appears without waiting for the next 200 ms tick.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scheduleRedraw = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        drawRef.current();
      });
    };

    const onMouseMove = (e: MouseEvent) => {
      hoverXRef.current = e.offsetX;
      scheduleRedraw();
    };
    const onMouseLeave = () => {
      hoverXRef.current = null;
      scheduleRedraw();
    };

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);
    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="h-full flex flex-col border-b border-app-border">
      <div className="shrink-0 p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.powerband_title()}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-app-text-dim">
            {packet && packet.powerW > 0 ? `${(packet.powerW / WATTS_PER_HORSEPOWER).toFixed(0)} hp` : ""}
            {packet && packet.torqueNm > 0 ? ` / ${packet.torqueNm.toFixed(0)} Nm` : ""}
          </span>
          {onToggleRecording && onReset && (
            <div className="flex items-center gap-2">
              {onToggleAutoRecording && (
                <label className="flex items-center gap-1 text-xs text-app-text-muted cursor-pointer select-none">
                  <input type="checkbox" checked={autoRecording} onChange={onToggleAutoRecording} style={{ accentColor: "var(--app-accent)" }} />
                  {m.powerband_auto()}
                </label>
              )}
              <Button size="app-sm" variant={recording ? "app-primary" : "app-outline"} onClick={onToggleRecording}>
                {recording ? m.powerband_record_stop() : m.powerband_record_start()}
              </Button>
              <Button size="app-sm" variant="app-outline" onClick={onReset}>
                {m.powerband_reset()}
              </Button>
            </div>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 280 }}>
        <canvas ref={canvasRef} className="w-full h-full rounded" style={{ cursor: "crosshair" }} />
      </div>
      <div className="shrink-0 p-2 border-t border-app-border/50">
        <div className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "var(--telemetry-power)" }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_power()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded border-dashed" style={{ borderTop: "1px dashed var(--telemetry-torque)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_torque()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "var(--status-warning)" }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_power_band()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--telemetry-power)" }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_peak_power()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--telemetry-torque)" }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_peak_torque()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed var(--app-text)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_cross()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed var(--status-danger)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.powerband_legend_redline()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed var(--app-accent)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.powerband_shift()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Draw a text label with a rounded background for readability */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, above: boolean, align: CanvasTextAlign = "center", bg: string = "color-mix(in srgb, var(--app-bg) 55%, transparent)") {
  ctx.font = "var(--text-app-caption) var(--font-sans)";
  const metrics = ctx.measureText(text);
  const paddingX = 5;
  const paddingY = 3;
  const h = 10 + paddingY * 2;
  const w = metrics.width + paddingX * 2;
  const rx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  const ry = above ? y - h - 4 : y + 4;
  const radius = 4;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(rx + radius, ry);
  ctx.lineTo(rx + w - radius, ry);
  ctx.quadraticCurveTo(rx + w, ry, rx + w, ry + radius);
  ctx.lineTo(rx + w, ry + h - radius);
  ctx.quadraticCurveTo(rx + w, ry + h, rx + w - radius, ry + h);
  ctx.lineTo(rx + radius, ry + h);
  ctx.quadraticCurveTo(rx, ry + h, rx, ry + h - radius);
  ctx.lineTo(rx, ry + radius);
  ctx.quadraticCurveTo(rx, ry, rx + radius, ry);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, rx + paddingX, ry + h / 2 + 0.5);
  ctx.textBaseline = "alphabetic";
}
