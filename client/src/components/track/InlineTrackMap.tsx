import { useEffect, useState } from "react";

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
    const centerline = element.tagName.toLowerCase() === "path" && classes.includes("center-line");
    const debugGeometry =
      classes.includes("track-limit") ||
      classes.includes("pit-lane") ||
      classes.includes("start-finish") ||
      classes.includes("grid") ||
      classes.includes("pit") ||
      classes.includes("garage");
    if (!centerline && (layers !== "debug" || !debugGeometry)) element.remove();
  });

  root.querySelectorAll<SVGElement>(".center-line, .track-limit, .pit-lane, .start-finish").forEach((element) => {
    const classes = element.getAttribute("class")?.split(/\s+/) ?? [];
    const stroke = classes.includes("center-line")
      ? layers === "centerline"
        ? "var(--track-outline)"
        : "var(--track-centerline)"
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
    element.setAttribute("stroke-width", classes.includes("center-line") ? (layers === "centerline" ? "2.5" : "2") : classes.includes("start-finish") ? "3" : classes.includes("pit-lane") ? "2" : "1.5");
    element.setAttribute("stroke-linecap", "round");
    element.setAttribute("stroke-linejoin", "round");
  });

  root.querySelectorAll<SVGCircleElement>("circle.grid, circle.pit, circle.garage").forEach((circle) => {
    const classes = circle.getAttribute("class")?.split(/\s+/) ?? [];
    circle.setAttribute("fill", classes.includes("grid") ? "var(--track-muted)" : classes.includes("pit") ? "var(--status-info)" : "var(--status-warning)");
    circle.setAttribute("stroke", "none");
    circle.setAttribute("r", classes.includes("grid") ? "2" : "1.5");
  });

  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  root.setAttribute("style", "display:block;width:100%;height:100%");
  root.setAttribute("aria-hidden", "true");
  return new XMLSerializer().serializeToString(root);
}

export function InlineTrackMap({ src, alt, className, layers = "centerline" }: InlineTrackMapProps) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  if (!svg) return <div className={className} aria-label={`${alt} loading`} />;
  return <div className={className} role="img" aria-label={alt} data-track-map-layers={layers} dangerouslySetInnerHTML={{ __html: svg }} />;
}
