import type { TrackImageryVenueManifest } from "../../../../../shared/racing/tracks/imagery";
import type { ImageryCalibrationModel } from "./useImageryCalibration";

interface ImageryPreviewProps {
  calibration: ImageryCalibrationModel;
  baseUrl: string | null;
  displayedLayers: TrackImageryVenueManifest["layers"];
  layerPreviewUrl: string | null;
  layerOpacity: number;
  venueId: string;
  assetVersion: number;
}

export function ImageryPreview({ calibration, baseUrl, displayedLayers, layerPreviewUrl, layerOpacity, venueId, assetVersion }: ImageryPreviewProps) {
  const { viewBounds, imageCorners, handles } = calibration;

  return (
    <main className="relative min-h-[24rem] overflow-hidden p-4 @7xl/workspace:min-h-0">
      {calibration.referenceLoading && <div className="grid h-full place-items-center text-sm text-app-text-muted">Loading calibration reference…</div>}
      {!calibration.referenceLoading && (!viewBounds || !calibration.calibration) && (
        <div className="grid h-full place-items-center text-sm text-app-text-muted">Select open imagery or upload a base image after resolving catalog GPS or choosing a recorded lap.</div>
      )}
      {!calibration.referenceLoading && viewBounds && calibration.calibration && (
        <svg
          className="h-full w-full cursor-default touch-none rounded border border-app-border bg-app-surface"
          viewBox={`${viewBounds.minX} ${viewBounds.minZ} ${viewBounds.width} ${viewBounds.height}`}
          onPointerMove={calibration.handlePointerMove}
          onPointerUp={calibration.handlePointerEnd}
          onPointerCancel={calibration.handlePointerEnd}
          aria-label="Track texture calibration preview"
        >
          {baseUrl && <image href={baseUrl} x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform={calibration.imageTransform} opacity="1" />}
          {displayedLayers.map((layer) => (
            <image
              key={layer.id}
              href={`/api/dev/track-imagery/venues/texture/${encodeURIComponent(layer.id)}?venueId=${encodeURIComponent(venueId)}&v=${assetVersion}`}
              x="0"
              y="0"
              width="1"
              height="1"
              preserveAspectRatio="none"
              transform={calibration.imageTransform}
              opacity={layer.opacity}
            />
          ))}
          {layerPreviewUrl && <image href={layerPreviewUrl} x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform={calibration.imageTransform} opacity={layerOpacity} />}
          <polygon
            points={imageCorners.map((point) => `${point.x},${point.z}`).join(" ")}
            fill="none"
            stroke="var(--app-accent)"
            strokeWidth={viewBounds.width / 600}
            strokeDasharray={`${viewBounds.width / 150} ${viewBounds.width / 150}`}
            pointerEvents="none"
          />
          <polyline
            points={calibration.gpsPolyline}
            fill="none"
            stroke="var(--track-outline-strong)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {handles && (
            <g>
              <line x1={handles.top.x} y1={handles.top.z} x2={handles.rotate.x} y2={handles.rotate.z} stroke="var(--app-accent)" strokeWidth={handles.radius * 0.35} pointerEvents="none" />
              {imageCorners.map((point, index) => (
                <rect
                  key={index}
                  data-calibration-handle="scale"
                  className="cursor-nwse-resize"
                  x={point.x - handles.radius}
                  y={point.z - handles.radius}
                  width={handles.radius * 2}
                  height={handles.radius * 2}
                  rx={handles.radius * 0.2}
                  fill="var(--app-accent)"
                  stroke="var(--app-bg)"
                  strokeWidth={handles.radius * 0.35}
                  onPointerDown={(event) => calibration.startDrag("scale", event)}
                >
                  <title>Drag to scale texture</title>
                </rect>
              ))}
              <circle
                data-calibration-handle="move"
                className="cursor-move"
                cx={handles.center.x}
                cy={handles.center.z}
                r={handles.radius * 1.25}
                fill="var(--app-accent)"
                stroke="var(--app-bg)"
                strokeWidth={handles.radius * 0.35}
                onPointerDown={(event) => calibration.startDrag("move", event)}
              >
                <title>Drag to move texture</title>
              </circle>
              <line
                x1={handles.center.x - handles.radius * 0.65}
                y1={handles.center.z}
                x2={handles.center.x + handles.radius * 0.65}
                y2={handles.center.z}
                stroke="var(--app-bg)"
                strokeWidth={handles.radius * 0.25}
                pointerEvents="none"
              />
              <line
                x1={handles.center.x}
                y1={handles.center.z - handles.radius * 0.65}
                x2={handles.center.x}
                y2={handles.center.z + handles.radius * 0.65}
                stroke="var(--app-bg)"
                strokeWidth={handles.radius * 0.25}
                pointerEvents="none"
              />
              <circle
                data-calibration-handle="rotate"
                className="cursor-grab"
                cx={handles.rotate.x}
                cy={handles.rotate.z}
                r={handles.radius * 1.25}
                fill="var(--app-accent)"
                stroke="var(--app-bg)"
                strokeWidth={handles.radius * 0.35}
                onPointerDown={(event) => calibration.startDrag("rotate", event)}
              >
                <title>Drag to rotate texture</title>
              </circle>
              <text x={handles.rotate.x} y={handles.rotate.z} dy="0.35em" fill="var(--app-bg)" fontSize={handles.radius * 1.4} textAnchor="middle" pointerEvents="none">
                ↻
              </text>
            </g>
          )}
        </svg>
      )}
      <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-app-bg/80 px-2 py-1 text-app-caption text-app-text-muted">
        Handles: center moves · corners scale · round handle rotates
      </div>
    </main>
  );
}
