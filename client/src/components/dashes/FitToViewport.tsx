import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface FitToViewportProps {
  children: ReactNode;
  /** Padding inside the viewport edges (px). Default 8. */
  padding?: number;
  /** Don't scale above this multiplier. Default 3. */
  maxScale?: number;
  /** Horizontal alignment of scaled content. Default "center". */
  alignX?: "start" | "center" | "end";
  /** Vertical alignment of scaled content. Default "center". */
  alignY?: "start" | "center" | "end";
  className?: string;
}

/**
 * Scales its content down (or up, within maxScale) so it fits the parent
 * container without scrolling. Useful for dash layouts that must display
 * the whole design regardless of device size.
 */
const X_MAP = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
} as const;
const Y_MAP = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
} as const;
const ORIGIN_X = { start: "left", center: "center", end: "right" } as const;
const ORIGIN_Y = { start: "top", center: "center", end: "bottom" } as const;

export function FitToViewport({ children, padding = 8, maxScale = 3, alignX = "center", alignY = "center", className = "" }: FitToViewportProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const update = () => {
      const availW = Math.max(0, outer.clientWidth - padding * 2);
      const availH = Math.max(0, outer.clientHeight - padding * 2);
      const contentW = inner.scrollWidth;
      const contentH = inner.scrollHeight;
      if (contentW === 0 || contentH === 0) return;
      const s = Math.min(availW / contentW, availH / contentH, maxScale);
      setScale(s > 0 ? s : 1);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [padding, maxScale]);

  useEffect(() => {
    const onResize = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const availW = Math.max(0, outer.clientWidth - padding * 2);
      const availH = Math.max(0, outer.clientHeight - padding * 2);
      const s = Math.min(availW / inner.scrollWidth, availH / inner.scrollHeight, maxScale);
      setScale(s > 0 ? s : 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [padding, maxScale]);

  return (
    <div ref={outerRef} className={`w-full h-full flex ${X_MAP[alignX]} ${Y_MAP[alignY]} overflow-hidden ${className}`} style={{ padding }}>
      <div
        ref={innerRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${ORIGIN_Y[alignY]} ${ORIGIN_X[alignX]}`,
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
