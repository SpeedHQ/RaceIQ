import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type TrackMapLayers = "centerline" | "debug";

interface InlineTrackMapProps {
  src: string;
  alt: string;
  className?: string;
  layers?: TrackMapLayers;
}

function renderTrackSvg(svg: string, layers: TrackMapLayers): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.querySelector("parsererror")) return "";

  root.querySelectorAll("*").forEach((element) => {
    const classes = element.getAttribute("class")?.split(/\s+/) ?? [];
    const path = element.tagName.toLowerCase() === "path";
    const centerline = path && classes.includes("center-line");
    const debugGeometry =
      (path && classes.includes("racing-line")) ||
      classes.includes("track-limit") ||
      classes.includes("pit-lane") ||
      classes.includes("start-finish") ||
      classes.includes("pit") ||
      classes.includes("garage");
    const visible = layers === "centerline" ? centerline : debugGeometry;
    if (!visible) element.remove();
  });

  root.querySelectorAll<SVGElement>(".center-line, .racing-line, .track-limit, .pit-lane, .start-finish").forEach((element) => {
    const classes = element.getAttribute("class")?.split(/\s+/) ?? [];
    const stroke = classes.includes("center-line")
      ? "var(--track-outline)"
      : classes.includes("racing-line")
        ? "var(--track-racing-line)"
        : classes.includes("pit-lane")
          ? "var(--track-pit-lane)"
          : classes.includes("start-finish")
            ? "var(--track-start)"
            : classes.includes("left")
              ? "var(--track-boundary-left)"
              : "var(--track-boundary-right)";
    element.removeAttribute("style");
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", stroke);
    element.setAttribute("stroke-width", classes.includes("racing-line") || classes.includes("center-line") ? "2.5" : classes.includes("start-finish") ? "3" : classes.includes("pit-lane") ? "2" : "1.5");
    element.setAttribute("stroke-linecap", "round");
    element.setAttribute("stroke-linejoin", "round");
  });

  root.querySelectorAll<SVGCircleElement>("circle.pit, circle.garage").forEach((circle) => {
    const classes = circle.getAttribute("class")?.split(/\s+/) ?? [];
    circle.setAttribute("fill", classes.includes("pit") ? "var(--status-info)" : "var(--status-warning)");
    circle.setAttribute("stroke", "none");
    circle.setAttribute("r", "1.5");
  });

  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  root.setAttribute("style", "display:block;width:100%;height:100%");
  root.setAttribute("aria-hidden", "true");
  return new XMLSerializer().serializeToString(root);
}

export function InlineTrackMap({ src, alt, className, layers = "centerline" }: InlineTrackMapProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const dragging = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  zoomRef.current = zoom;
  panRef.current = pan;

  useEffect(() => {
    let cancelled = false;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    void fetch(src)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((text) => {
        if (!cancelled) setSvg(renderTrackSvg(text, layers));
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, layers]);

  useEffect(() => {
    if (layers !== "debug") return;
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const currentZoom = zoomRef.current;
      const nextZoom = Math.min(Math.max(currentZoom * 0.999 ** event.deltaY, 0.5), 8);
      if (Math.abs(nextZoom - currentZoom) < 0.001) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const ratio = nextZoom / currentZoom;
      setZoom(nextZoom);
      setPan({
        x: x - (x - panRef.current.x) * ratio,
        y: y - (y - panRef.current.y) * ratio,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [layers, svg]);

  if (!svg) return <div className={className} aria-label={`${alt} loading`} />;
  if (layers === "centerline") {
    return <div className={className} role="img" aria-label={alt} data-track-map-layers={layers} dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      className={`${className ?? ""} relative overflow-hidden touch-none cursor-grab active:cursor-grabbing`}
      data-track-map-layers={layers}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest("button")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      }}
      onPointerMove={(event) => {
        if (dragging.current?.pointerId !== event.pointerId) return;
        setPan({
          x: dragging.current.panX + event.clientX - dragging.current.x,
          y: dragging.current.panY + event.clientY - dragging.current.y,
        });
      }}
      onPointerUp={(event) => {
        if (dragging.current?.pointerId !== event.pointerId) return;
        dragging.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    >
      <div
        className="h-full w-full"
        role="img"
        aria-label={alt}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center" }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <Button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom((value) => Math.min(value + 0.25, 8))}
          className="flex h-7 w-7 items-center justify-center rounded border border-app-border-input bg-app-surface-alt/80 text-app-body text-app-text-secondary hover:text-app-text"
        >
          +
        </Button>
        <Button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom((value) => Math.max(value - 0.25, 0.5))}
          className="flex h-7 w-7 items-center justify-center rounded border border-app-border-input bg-app-surface-alt/80 text-app-body text-app-text-secondary hover:text-app-text"
        >
          -
        </Button>
        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
          <Button
            type="button"
            aria-label="Reset map view"
            onClick={resetView}
            className="flex h-7 min-w-7 items-center justify-center rounded border border-app-border-input bg-app-surface-alt/80 px-1 text-app-micro text-app-text-secondary hover:text-app-text"
          >
            {zoom.toFixed(1)}x
          </Button>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-app-surface/80 px-2 py-1 font-mono text-app-micro text-app-text-dim backdrop-blur-sm">
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-2 border-(--track-racing-line)" />
          Racing line
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-2 border-(--track-boundary-left)" />
          Left edge
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-2 border-(--track-boundary-right)" />
          Right edge
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-2 border-(--track-pit-lane)" />
          Pit lane
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 border-t-[3px] border-(--track-start)" />
          Start/finish
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-status-info" />
          Pit
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-status-warning" />
          Garage
        </span>
      </div>
    </div>
  );
}
