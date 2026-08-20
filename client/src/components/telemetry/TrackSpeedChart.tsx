import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GEAR_COLORS } from "../../lib/colors";
import type { TrackSpeedLap } from "../../lib/gearing-telemetry";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { m } from "../../paraglide/messages";
import { Button } from "../ui/button";

interface Props {
  /** Current lap trace + the most recently completed lap (may be null). */
  laps: { current: TrackSpeedLap | null; previous: TrackSpeedLap | null };
  /** Convert metres → user distance unit. */
  toDistance: (metres: number) => number;
  /** Label for the distance unit, e.g. "km" or "mi". */
  distanceLabel: string;
  speedLabel: string;
  /** When provided, the header renders a Reset button that clears the traces. */
  onReset?: () => void;
}

/** "Nice" tick step (1/2/5 × 10ⁿ) that yields ~targetTicks ticks over a domain. */
function niceStep(domain: number, targetTicks: number): number {
  if (domain <= 0) return 1;
  const raw = domain / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

/**
 * Track Speed — per-lap line chart of speed vs distance.
 * X axis is the distance travelled since the lap's first sample (user unit);
 * Y axis is the speed in the user's unit. When a new lap starts the previous
 * lap trace is retained, and the header button toggles between the current
 * and the previous lap.
 */
export function TrackSpeedChart({ laps, toDistance, distanceLabel, speedLabel, onReset }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef(() => {});
  // Hover state kept in refs to avoid re-renders; the draw loop reads them on every frame.
  const hoverXRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [view, setView] = useState<"current" | "previous">("current");

  // Mirror props/state into refs so the draw closure (registered once) always
  // sees fresh values without re-registering on every 50 ms poll re-render.
  const lapsRef = useRef(laps);
  const viewRef = useRef(view);
  const toDistanceRef = useRef(toDistance);
  const distanceLabelRef = useRef(distanceLabel);
  const speedLabelRef = useRef(speedLabel);
  lapsRef.current = laps;
  viewRef.current = view;
  toDistanceRef.current = toDistance;
  distanceLabelRef.current = distanceLabel;
  speedLabelRef.current = speedLabel;

  // If the previous lap disappears (session change / reset), fall back to current.
  useEffect(() => {
    if (view === "previous" && !laps.previous) setView("current");
  }, [view, laps.previous]);

  const selected = view === "current" ? laps.current : laps.previous;
  const samples = selected?.samples ?? [];
  const canToggle = laps.previous != null;
  // Gears present in the selected trace, for the legend.
  const presentGears = samples
    .map((s) => s.gear)
    .filter((gear, i, arr) => gear >= 1 && arr.indexOf(gear) === i)
    .sort((a, b) => a - b);

  useLayoutEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const ctx = getSemanticCanvasContext(canvas);
      if (!ctx) return;

      const width = container.clientWidth;
      const height = 260;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const pad = { top: 20, right: 48, bottom: 32, left: 56 };
      const cW = width - pad.left - pad.right;
      const cH = height - pad.top - pad.bottom;

      const data = viewRef.current === "current" ? (lapsRef.current.current?.samples ?? []) : (lapsRef.current.previous?.samples ?? []);
      const toDistance = toDistanceRef.current;
      const distanceLabel = distanceLabelRef.current;
      const speedLabel = speedLabelRef.current;

      // Background
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(pad.left, pad.top, cW, cH);

      // Domains: distance from the lap baseline, speed from zero with headroom.
      const maxDist = Math.max(1, toDistance(data.length > 0 ? data[data.length - 1].distance : 0));
      const maxSpeedRaw = data.reduce((acc, s) => Math.max(acc, s.speed), 0);
      const maxSpeed = Math.max(10, maxSpeedRaw * 1.1);

      const sx = (dist: number) => pad.left + (dist / maxDist) * cW;
      const sy = (speed: number) => pad.top + cH - (speed / maxSpeed) * cH;

      // Gridlines — X (distance)
      ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 10%, transparent)";
      ctx.lineWidth = 1;
      ctx.font = "var(--text-app-label) var(--font-mono)";
      ctx.fillStyle = "var(--app-text-dim)";
      ctx.textAlign = "center";
      const xStep = niceStep(maxDist, 4);
      const xDecimals = xStep >= 1 ? 0 : xStep >= 0.1 ? 1 : 2;
      for (let dist = 0; dist <= maxDist + xStep / 2; dist += xStep) {
        const x = sx(dist);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + cH);
        ctx.stroke();
        ctx.fillText(dist.toFixed(xDecimals), x, pad.top + cH + 16);
      }

      // Gridlines — Y (speed)
      ctx.textAlign = "right";
      const yStep = niceStep(maxSpeed, 4);
      for (let speed = 0; speed <= maxSpeed + yStep / 2; speed += yStep) {
        const y = sy(speed);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + cW, y);
        ctx.stroke();
        ctx.fillText(speed.toFixed(0), pad.left - 6, y + 4);
      }

      // Axis labels
      ctx.fillStyle = "var(--app-text-muted)";
      ctx.textAlign = "center";
      ctx.fillText(`${m.trackspeed_distance()} (${distanceLabel})`, pad.left + cW / 2, height - 6);
      ctx.save();
      ctx.translate(12, pad.top + cH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${m.label_speed()} (${speedLabel})`, 0, 0);
      ctx.restore();

      if (data.length < 2) {
        // Empty state: no lap trace yet
        ctx.fillStyle = "var(--app-text-dim)";
        ctx.font = "var(--text-app-subtext) var(--font-sans)";
        ctx.textAlign = "center";
        ctx.fillText(m.trackspeed_empty_state(), pad.left + cW / 2, pad.top + cH / 2);
      } else {
        // Area fill under the speed line
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const x = sx(toDistance(data[i].distance));
          const y = sy(data[i].speed);
          if (i === 0) ctx.moveTo(x, pad.top + cH);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(sx(toDistance(data[data.length - 1].distance)), pad.top + cH);
        ctx.closePath();
        ctx.fillStyle = "color-mix(in srgb, var(--telemetry-speed) 12%, transparent)";
        ctx.fill();

        // Per-gear colored segments: consecutive samples in the same gear share one path.
        const gearRuns: { gear: number; xs: number[]; ys: number[] }[] = [];
        for (let i = 0; i < data.length; i++) {
          const x = sx(toDistance(data[i].distance));
          const y = sy(data[i].speed);
          const gear = data[i].gear;
          let run = gearRuns[gearRuns.length - 1];
          if (!run || run.gear !== gear) {
            run = { gear, xs: [], ys: [] };
            gearRuns.push(run);
          }
          run.xs.push(x);
          run.ys.push(y);
        }
        ctx.lineWidth = 2.5;
        for (const run of gearRuns) {
          ctx.strokeStyle = run.gear >= 1 ? GEAR_COLORS[(run.gear - 1) % GEAR_COLORS.length] : "var(--telemetry-speed)";
          if (run.xs.length === 1) {
            // Lone sample in a gear — draw a dot so it stays visible.
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.arc(run.xs[0], run.ys[0], 3, 0, Math.PI * 2);
            ctx.fill();
            continue;
          }
          ctx.beginPath();
          ctx.moveTo(run.xs[0], run.ys[0]);
          for (let i = 1; i < run.xs.length; i++) ctx.lineTo(run.xs[i], run.ys[i]);
          ctx.stroke();
        }

        // Live dot at the current position
        const last = data[data.length - 1];
        ctx.fillStyle = last.gear >= 1 ? GEAR_COLORS[(last.gear - 1) % GEAR_COLORS.length] : "var(--telemetry-speed)";
        ctx.beginPath();
        ctx.arc(sx(toDistance(last.distance)), sy(last.speed), 4, 0, Math.PI * 2);
        ctx.fill();

        // Hover crosshair + tooltip (distance & speed at the cursor)
        const hoverX = hoverXRef.current;
        if (hoverX !== null) {
          const frac = (hoverX - pad.left) / cW;
          if (frac >= 0 && frac <= 1) {
            const hoverM = frac * last.distance;
            // Nearest sample by distance (samples are appended in time order, distances monotonic).
            let nearest = data[0];
            let best = Infinity;
            for (let i = 0; i < data.length; i++) {
              const d = Math.abs(data[i].distance - hoverM);
              if (d < best) {
                best = d;
                nearest = data[i];
              }
            }
            const cx = sx(toDistance(nearest.distance));
            const cy = sy(nearest.speed);

            // Vertical crosshair
            ctx.save();
            ctx.strokeStyle = "var(--app-text-dim)";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx, pad.top);
            ctx.lineTo(cx, pad.top + cH);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();

            // Dot on the line
            ctx.fillStyle = nearest.gear >= 1 ? GEAR_COLORS[(nearest.gear - 1) % GEAR_COLORS.length] : "var(--telemetry-speed)";
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();

            // Tooltip box
            const tooltipLines: { label: string; value: string; color: string }[] = [
              { label: m.trackspeed_distance(), value: `${toDistance(nearest.distance).toFixed(2)} ${distanceLabel}`, color: "var(--app-text)" },
              { label: m.label_speed(), value: `${nearest.speed.toFixed(0)} ${speedLabel}`, color: "var(--telemetry-speed)" },
            ];
            const tFont = "var(--text-app-label) var(--font-mono)";
            ctx.font = tFont;
            const lineH = 16;
            const tPadX = 8;
            const tPadY = 6;
            const labelW = 56;
            const maxValueW = Math.max(...tooltipLines.map((l) => ctx.measureText(l.value).width));
            const tooltipW = tPadX + labelW + 6 + maxValueW + tPadX;
            const tooltipH = tooltipLines.length * lineH + tPadY * 2;

            // Flip tooltip to the left when the cursor is in the right 40 % of the chart
            const toRight = cx < pad.left + cW * 0.6;
            const tooltipXPos = toRight ? cx + 10 : cx - tooltipW - 10;
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
          }
        }
      }

      // Border
      ctx.strokeStyle = "var(--app-border)";
      ctx.lineWidth = 1;
      ctx.strokeRect(pad.left, pad.top, cW, cH);
    };
  }, []); // stable — reads from refs, no re-registration needed

  // Redraw immediately when the lap toggle flips instead of waiting for the next tick.
  useEffect(() => {
    drawRef.current();
  }, [view]);

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

  // Periodic redraw so appended samples appear without per-render work.
  useEffect(() => {
    drawRef.current();
    const id = setInterval(() => drawRef.current(), 200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-full flex flex-col border-b border-app-border">
      <div className="shrink-0 p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.trackspeed_title()}</h2>
        <div className="flex items-center gap-2">
          {selected && samples.length > 0 && (
            <span className="text-xs font-mono text-app-text-dim">
              {m.label_lap()} {selected.lapNumber} · {samples[samples.length - 1].speed.toFixed(0)} {speedLabel}
            </span>
          )}
          <Button size="app-sm" variant="app-outline" disabled={!canToggle} onClick={() => setView(view === "current" ? "previous" : "current")}>
            {view === "current" ? m.trackspeed_show_previous() : m.trackspeed_show_current()}
          </Button>
          {onReset && (
            <Button size="app-sm" variant="app-outline" onClick={onReset}>
              {m.powerband_reset()}
            </Button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 260 }}>
        <canvas ref={canvasRef} className="w-full h-full rounded" style={{ cursor: "crosshair" }} />
      </div>
      {presentGears.length > 0 && (
        <div className="shrink-0 p-2 border-t border-app-border/50">
          <div className="flex gap-3 flex-wrap">
            {presentGears.map((gear) => (
              <div key={gear} className="flex items-center gap-1">
                <div className="w-3 h-0.5 rounded" style={{ backgroundColor: GEAR_COLORS[(gear - 1) % GEAR_COLORS.length] }} />
                <span className="text-xs text-app-text-muted">{gear}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
